// Node-host ACP command handler. Manages acpx subprocess lifecycle per turn.
// Three event types:
//   acp.spawn  — validate agent binary, confirm readiness
//   acp.turn   — spawn acpx process, stream ndjson lines back as events
//   acp.kill   — kill active acpx process for a session

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { GatewayClient } from "../gateway/client.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import {
  type WindowsSpawnInvocation,
  resolveWindowsSpawnProgram,
  materializeWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";

export type AcpNodeSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_ACP_NODE_SPAWN_RUNTIME: AcpNodeSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

/** Resolve command + args through the Windows spawn pipeline so .cmd wrappers are handled. */
export function resolveAcpNodeSpawnInvocation(
  command: string,
  args: string[],
  runtime: AcpNodeSpawnRuntime = DEFAULT_ACP_NODE_SPAWN_RUNTIME,
): WindowsSpawnInvocation {
  const program = resolveWindowsSpawnProgram({
    command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    allowShellFallback: true,
  });
  return materializeWindowsSpawnProgram(program, args);
}

type ActiveTurn = {
  process: ChildProcess;
  readline: ReadlineInterface;
};

const activeTurns = new Map<string, ActiveTurn>();

type AcpEvent = {
  event: string;
  payload?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function sendNodeEvent(
  client: GatewayClient,
  event: string,
  payload: unknown,
): Promise<void> {
  try {
    await client.request("node.event", {
      event,
      payloadJSON: payload ? JSON.stringify(payload) : null,
    });
  } catch {
    // node events are best-effort
  }
}

function killProcess(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already exited
  }
  setTimeout(() => {
    try {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    } catch {
      // already exited
    }
  }, 3000);
}

async function handleSpawn(payload: Record<string, unknown>, client: GatewayClient): Promise<void> {
  const acpSessionId = asString(payload.acpSessionId);
  const agentCommand = asString(payload.agentCommand) || "acpx";
  const agent = asString(payload.agent) || "claude";
  const cwd = asString(payload.cwd) || process.cwd();

  // Validate agent binary is available
  const pathEnv = process.env.PATH ?? "";
  const resolved = resolveExecutableFromPathEnv(agentCommand, pathEnv);
  if (!resolved) {
    await sendNodeEvent(client, "acp.error", {
      acpSessionId,
      error: `Agent command not found: ${agentCommand}`,
    });
    return;
  }

  // Resolve spawn invocation outside the session-creation try/catch so that
  // resolution errors (filesystem I/O, .cmd parsing) are not silently swallowed
  // as "session may already exist."
  const sessionInvocation = resolveAcpNodeSpawnInvocation(resolved, [
    agent,
    "sessions",
    "new",
    "--name",
    acpSessionId,
  ]);

  // Ensure acpx session exists for this cwd (acpx 0.1.16+ requires it)
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(sessionInvocation.command, sessionInvocation.argv, {
      cwd,
      timeout: 10_000,
      stdio: ["ignore", "ignore", "pipe"],
      shell: sessionInvocation.shell,
      windowsHide: sessionInvocation.windowsHide,
    });
  } catch {
    // Session may already exist or sessions new may not be supported — continue anyway
  }

  await sendNodeEvent(client, "acp.spawned", {
    acpSessionId,
    agentCommand,
  });
}

async function handleTurn(payload: Record<string, unknown>, client: GatewayClient): Promise<void> {
  const acpSessionId = asString(payload.acpSessionId);
  const agent = asString(payload.agent) || "claude";
  const text = asString(payload.text);
  const _sessionName = asString(payload.sessionName);
  const cwd = asString(payload.cwd) || process.cwd();
  const permissionMode = asString(payload.permissionMode) || "approve-all";
  const agentCommand = asString(payload.agentCommand) || "acpx";
  const mode = asString(payload.mode) || "prompt";

  if (!text) {
    await sendNodeEvent(client, "acp.error", {
      acpSessionId,
      error: "No prompt text provided",
    });
    return;
  }

  // Kill any existing turn for this session
  const existing = activeTurns.get(acpSessionId);
  if (existing) {
    killProcess(existing.process);
    existing.readline.close();
    activeTurns.delete(acpSessionId);
  }

  // Build acpx arguments
  // acpx 0.3.0+ uses --approve-all/--deny-all instead of --permission-mode
  const permissionArgs =
    permissionMode === "approve-all"
      ? ["--approve-all"]
      : permissionMode === "deny-all"
        ? ["--deny-all"]
        : [];
  const args: string[] = [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    cwd,
    ...permissionArgs,
    "--non-interactive-permissions",
    "deny",
    agent,
    mode,
    "--session",
    acpSessionId,
    "--file",
    "-",
  ];

  // When shell fallback is active (shell: true on Windows), cmd.exe spawns
  // successfully even if the inner command fails. Errors surface as non-zero
  // exit codes + stderr rather than the 'error' event. The exit handler below
  // accounts for this by emitting acp.error for non-zero shell-mode exits.
  let child: ChildProcess;
  let usedShell = false;
  try {
    const turnInvocation = resolveAcpNodeSpawnInvocation(agentCommand, args);
    usedShell = turnInvocation.shell === true;
    child = spawn(turnInvocation.command, turnInvocation.argv, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      shell: turnInvocation.shell,
      windowsHide: turnInvocation.windowsHide,
    });
  } catch (err) {
    await sendNodeEvent(client, "acp.error", {
      acpSessionId,
      error: `Failed to spawn ${agentCommand}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const readline = createInterface({ input: child.stdout! });
  activeTurns.set(acpSessionId, { process: child, readline });

  // Feed prompt text via stdin
  child.stdin!.on("error", () => {
    // Ignore EPIPE
  });
  child.stdin!.end(text);

  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });

  // Stream ndjson lines back as acp.message events
  readline.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    void sendNodeEvent(client, "acp.message", {
      acpSessionId,
      line: trimmed,
    });
  });

  child.on("exit", (exitCode: number | null) => {
    readline.close();
    activeTurns.delete(acpSessionId);

    // In shell fallback mode, command failures appear as non-zero exits rather
    // than 'error' events. Surface them as acp.error so downstream consumers
    // see a consistent error channel regardless of spawn mode.
    if (usedShell && exitCode && exitCode !== 0 && stderr.trim()) {
      void sendNodeEvent(client, "acp.error", {
        acpSessionId,
        error: `${agentCommand} exited with code ${exitCode} (shell mode): ${stderr.trim().slice(0, 500)}`,
      });
    }

    void sendNodeEvent(client, "acp.exited", {
      acpSessionId,
      exitCode: exitCode ?? -1,
      stderr: stderr.trim(),
    });
  });

  child.on("error", (err: Error) => {
    readline.close();
    activeTurns.delete(acpSessionId);

    void sendNodeEvent(client, "acp.error", {
      acpSessionId,
      error: err.message,
    });
  });
}

function handleKill(payload: Record<string, unknown>): void {
  const acpSessionId = asString(payload.acpSessionId);
  const active = activeTurns.get(acpSessionId);
  if (!active) {
    return;
  }
  killProcess(active.process);
  active.readline.close();
  activeTurns.delete(acpSessionId);
}

export function handleAcpEvent(evt: AcpEvent, client: GatewayClient): void {
  const payload = asRecord(evt.payload);
  if (!payload) {
    return;
  }

  switch (evt.event) {
    case "acp.spawn":
      void handleSpawn(payload, client);
      break;
    case "acp.turn":
      void handleTurn(payload, client);
      break;
    case "acp.kill":
      handleKill(payload);
      break;
  }
}
