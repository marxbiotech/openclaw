import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  GatewayCallOptions,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/claude-node";
import {
  callGatewayTool,
  readGatewayCallOptions,
  resolveNodeId,
} from "openclaw/plugin-sdk/claude-node";

export type ClaudeNodePluginConfig = {
  nodeName?: string;
  defaultCwd?: string;
  timeoutMs?: number;
  model?: string;
  dangerouslySkipPermissions?: boolean;
};

const ClaudeCodeToolSchema = Type.Object(
  {
    message: Type.String({
      description: "The task or prompt to send to Claude Code CLI.",
    }),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory override on the node.",
      }),
    ),
    sessionId: Type.Optional(
      Type.String({
        description:
          "Claude Code session ID to resume. Pass the session_id from a previous call's result " +
          "to continue that session. Omit to start a new session.",
      }),
    ),
  },
  { additionalProperties: false },
);

type NodeInvokeResult = {
  payload?: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
};

type ClaudeJsonResult = {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  duration_ms?: number;
  is_error?: boolean;
};

/**
 * Parse Claude CLI JSON output (--output-format json).
 * The output contains newline-delimited JSON messages.
 * We want the final "result" message for the text output,
 * and any message's session_id for session tracking.
 */
function parseClaudeJsonOutput(stdout: string): {
  sessionId: string | undefined;
  text: string;
  isError: boolean;
} {
  let sessionId: string | undefined;
  let text = "";
  let isError = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as ClaudeJsonResult;
      if (msg.session_id) {
        sessionId = msg.session_id;
      }
      if (msg.type === "result") {
        text = msg.result ?? "";
        isError = msg.is_error === true;
      }
    } catch {
      // Not JSON — skip
    }
  }

  // Fallback: if no result message parsed, use raw stdout
  if (!text && stdout.trim()) {
    text = stdout.trim();
  }

  return { sessionId, text, isError };
}

export function createClaudeCodeTool(params: {
  api: OpenClawPluginApi;
  pluginConfig: ClaudeNodePluginConfig;
}): AnyAgentTool {
  const { api, pluginConfig } = params;
  const timeoutMs = pluginConfig.timeoutMs ?? 600_000;

  return {
    name: "claude_code",
    label: "Claude Code",
    description:
      "Dispatch a coding task to Claude Code CLI running on a paired Mac node. " +
      "Use this for code generation, debugging, refactoring, test writing, code review, " +
      "git operations, and file modifications. " +
      "Returns a session_id in the result — pass it back as sessionId to continue the same session.",
    parameters: ClaudeCodeToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const toolParams = rawParams as {
        message: string;
        cwd?: string;
        sessionId?: string;
      };

      const gatewayOpts: GatewayCallOptions = readGatewayCallOptions({
        timeoutMs,
      });

      const nodeId = await resolveNodeId(
        gatewayOpts,
        pluginConfig.nodeName,
        /* allowDefault */ true,
      );

      // Build argv
      const argv: string[] = [
        "claude",
        "--print",
        "-p",
        toolParams.message,
        "--output-format",
        "json",
      ];

      if (pluginConfig.dangerouslySkipPermissions !== false) {
        argv.push("--dangerously-skip-permissions");
      }

      if (pluginConfig.model) {
        argv.push("--model", pluginConfig.model);
      }

      // Resume existing session: claude --resume <session-id>
      if (toolParams.sessionId) {
        argv.push("--resume", toolParams.sessionId);
      }

      const cwd = toolParams.cwd ?? pluginConfig.defaultCwd;

      api.logger.info?.(
        `claude_code: dispatching to node ${nodeId}` +
          (toolParams.sessionId ? ` (resuming session ${toolParams.sessionId})` : " (new session)"),
      );

      const result = await callGatewayTool<NodeInvokeResult>(
        "node.invoke",
        { ...gatewayOpts, timeoutMs },
        {
          nodeId,
          command: "system.run",
          params: {
            command: argv,
            cwd,
            env: {},
          },
        },
      );

      // Parse result
      const payload = result?.payload ?? (result as NodeInvokeResult["payload"]);
      const stdout = payload?.stdout ?? "";
      const stderr = payload?.stderr ?? "";
      const exitCode = payload?.exitCode ?? -1;

      if (exitCode !== 0) {
        const errorText = stderr || stdout || `Claude Code exited with code ${exitCode}`;
        return {
          content: [
            {
              type: "text",
              text: `Claude Code error (exit ${exitCode}):\n${errorText}`,
            },
          ],
          details: { exitCode, stderr, stdout },
        };
      }

      // Parse JSON output to extract session_id and result text
      const parsed = parseClaudeJsonOutput(stdout);

      return {
        content: [
          {
            type: "text",
            text: parsed.text || "(no output)",
          },
        ],
        details: {
          exitCode,
          session_id: parsed.sessionId,
          isError: parsed.isError,
        },
      };
    },
  };
}
