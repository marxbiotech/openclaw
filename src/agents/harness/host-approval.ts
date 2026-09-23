/** Shared closure-bound approval transport for admitted native and ACP runtimes. */
import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { registerMcpToolApprovalBinding } from "../../infra/mcp-tool-approval-binding.js";
import { withGatewayToolApprovalOwner } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type AgentHarnessHostApprovalResult = NonNullable<
  Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>
>;

/** The caller supplies owner-held authority; this adapter does not mint or persist grants. */
export function createRunApprovalCapability(params: {
  pluginId: string;
  agentId?: string;
  delegatedAuthority: AgentRunDelegatedAuthority;
  assertActive: () => void;
  withCaller: <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}): Pick<AgentHarnessHostCapabilities, "requestApproval" | "waitForApproval"> {
  return {
    requestApproval: async (request) => {
      params.assertActive();
      request.signal?.throwIfAborted();
      const releaseMcpBinding =
        request.mcpTool && request.toolCallId && request.isMcpToolApprovalActive && params.agentId
          ? registerMcpToolApprovalBinding({
              authority: params.delegatedAuthority,
              agentId: params.agentId,
              toolCallId: request.toolCallId,
              ...request.mcpTool,
              isActive: () => {
                params.assertActive();
                return !request.signal?.aborted && request.isMcpToolApprovalActive!();
              },
            })
          : undefined;
      try {
        const result = await params.withCaller(
          async () =>
            await withGatewayToolApprovalOwner(
              params.pluginId,
              async () =>
                await callGatewayTool(
                  "plugin.approval.request",
                  { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
                  {
                    title: request.title,
                    description: request.description,
                    severity: request.severity,
                    toolName: request.toolName,
                    toolCallId: request.toolCallId,
                    ...(request.mcpTool ? { mcpTool: request.mcpTool } : {}),
                    timeoutMs: request.timeoutMs,
                    twoPhase: true,
                    ...(request.allowedDecisions
                      ? { allowedDecisions: request.allowedDecisions }
                      : {}),
                  },
                  { expectFinal: false, requireAgentRuntimeIdentity: true, signal: request.signal },
                ),
            ),
          request.signal,
        );
        // Gateway approval calls may outlive their owning attempt. A late
        // request result must not escape after exact authority has closed.
        params.assertActive();
        request.signal?.throwIfAborted();
        return result;
      } finally {
        releaseMcpBinding?.();
      }
    },
    waitForApproval: async (request) => {
      params.assertActive();
      const result = await params.withCaller(
        async () =>
          await callGatewayTool<{ id?: string } & Partial<AgentHarnessHostApprovalResult>>(
            "plugin.approval.waitDecision",
            { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
            { id: request.approvalId },
            { signal: request.signal },
          ),
        request.signal,
      );
      // An allowed decision is useful only while this exact admitted owner is
      // still live; fail closed if closure raced the awaited Gateway result.
      params.assertActive();
      if (result?.id !== request.approvalId) {
        return undefined;
      }
      return {
        decision: result.decision,
        terminalReason: result.terminalReason,
      };
    },
  };
}
