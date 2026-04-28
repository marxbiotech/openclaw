import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { handleAcpEvent, resolveAcpNodeSpawnInvocation } from "./invoke-acp.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("invoke-acp-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

type CapturedEvent = { event: string; payload: Record<string, unknown> };

function createMockClient(): { client: GatewayClient; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const client = {
    request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
      const event = typeof params.event === "string" ? params.event : "";
      const payloadJSON = typeof params.payloadJSON === "string" ? params.payloadJSON : "{}";
      events.push({ event, payload: JSON.parse(payloadJSON) as Record<string, unknown> });
    }),
  } as unknown as GatewayClient;
  return { client, events };
}

/** Wait for handleAcpEvent's fire-and-forget promise to settle. */
async function flush(): Promise<void> {
  // handleAcpEvent uses `void handleSpawn(...)` (fire-and-forget).
  // Flush the microtask queue so the async function completes.
  await new Promise((r) => setTimeout(r, 50));
}

describe("resolveAcpNodeSpawnInvocation", () => {
  it("passes through command and args on non-windows platforms", () => {
    // On darwin/linux the function should return the command unchanged
    // (resolveWindowsSpawnProgram is a no-op on non-win32)
    const result = resolveAcpNodeSpawnInvocation("acpx", ["claude", "prompt", "--session", "s1"], {
      platform: "linux",
      env: {},
      execPath: "/usr/bin/node",
    });
    expect(result.command).toBe("acpx");
    expect(result.argv).toEqual(["claude", "prompt", "--session", "s1"]);
    expect(result.shell).toBeUndefined();
    expect(result.windowsHide).toBeUndefined();
  });

  it("unwraps .cmd shim entrypoint on simulated windows", async () => {
    const dir = await createTempDir();
    const scriptPath = path.join(dir, "acpx", "dist", "entry.js");
    const shimPath = path.join(dir, "acpx.cmd");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "console.log('ok')\n", "utf8");
    await writeFile(shimPath, `@ECHO off\r\n"%~dp0\\acpx\\dist\\entry.js" %*\r\n`, "utf8");

    // resolveAcpNodeSpawnInvocation accepts an injectable runtime so we can
    // simulate Windows without mocking process.platform.
    const result = resolveAcpNodeSpawnInvocation(
      shimPath,
      ["claude", "prompt", "--session", "s1"],
      {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
      },
    );

    expect(result.command).toBe("C:\\node\\node.exe");
    expect(result.argv).toEqual([scriptPath, "claude", "prompt", "--session", "s1"]);
    expect(result.shell).toBeUndefined();
    expect(result.windowsHide).toBe(true);
  });

  it("falls back to shell mode for unresolved .cmd wrappers on simulated windows", async () => {
    const dir = await createTempDir();
    const shimPath = path.join(dir, "acpx.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const result = resolveAcpNodeSpawnInvocation(shimPath, ["claude", "prompt"], {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(result.command).toBe(shimPath);
    expect(result.argv).toEqual(["claude", "prompt"]);
    expect(result.shell).toBe(true);
  });
});

describe("handleAcpEvent — acp.spawn", () => {
  it("sends acp.spawned when session creation succeeds", async () => {
    const dir = await createTempDir();
    const scriptPath = path.join(dir, "fake-acpx");
    // Script that exits 0 (success)
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(scriptPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const { client, events } = createMockClient();
      handleAcpEvent(
        {
          event: "acp.spawn",
          payload: {
            acpSessionId: "racp-test-ok",
            agentCommand: "fake-acpx",
            agent: "claude",
            cwd: dir,
          },
        },
        client,
      );
      await flush();

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("acp.spawned");
      expect(events[0].payload.acpSessionId).toBe("racp-test-ok");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("sends acp.error when session creation command fails", async () => {
    const dir = await createTempDir();
    const scriptPath = path.join(dir, "fail-acpx");
    // Script that writes to stderr and exits non-zero
    await writeFile(scriptPath, '#!/bin/sh\necho "session init error" >&2\nexit 1\n', "utf8");
    await chmod(scriptPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const { client, events } = createMockClient();
      handleAcpEvent(
        {
          event: "acp.spawn",
          payload: {
            acpSessionId: "racp-test-fail",
            agentCommand: "fail-acpx",
            agent: "claude",
            cwd: dir,
          },
        },
        client,
      );
      await flush();

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("acp.error");
      expect(events[0].payload.acpSessionId).toBe("racp-test-fail");
      expect(events[0].payload.error).toContain("sessions new failed");
      expect(events[0].payload.error).toContain("session init error");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("sends acp.error when agent command is not found in PATH", async () => {
    const { client, events } = createMockClient();
    handleAcpEvent(
      {
        event: "acp.spawn",
        payload: {
          acpSessionId: "racp-test-notfound",
          agentCommand: "nonexistent-acpx-binary-xyz",
          agent: "claude",
          cwd: "/tmp",
        },
      },
      client,
    );
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("acp.error");
    expect(events[0].payload.acpSessionId).toBe("racp-test-notfound");
    expect(events[0].payload.error).toContain("Agent command not found");
  });

  it("does not send acp.spawned when session creation fails", async () => {
    const dir = await createTempDir();
    const scriptPath = path.join(dir, "bad-acpx");
    await writeFile(scriptPath, "#!/bin/sh\nexit 2\n", "utf8");
    await chmod(scriptPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const { client, events } = createMockClient();
      handleAcpEvent(
        {
          event: "acp.spawn",
          payload: {
            acpSessionId: "racp-test-no-spawned",
            agentCommand: "bad-acpx",
            agent: "claude",
            cwd: dir,
          },
        },
        client,
      );
      await flush();

      const spawnedEvents = events.filter((e) => e.event === "acp.spawned");
      expect(spawnedEvents).toHaveLength(0);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
