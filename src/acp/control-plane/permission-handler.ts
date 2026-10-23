/** Adapts unresolved native ACP permissions to the existing run-bound plugin approval owner. */
import type { AcpPermissionDecision } from "@openclaw/acp-core/runtime/types";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { formatHarnessApprovalPresentation } from "../../agents/harness/native-hook-relay-approval-presentation.js";
import { readAcpSpawnParentDeliveryContext } from "../../agents/subagents/spawn/acp-spawn-requester.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AcpManagerPermissionHandler } from "./manager.types.js";

const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PENDING_PERMISSIONS = 32;
const CANCEL: AcpPermissionDecision = { outcome: "cancel" };

export type AcpPermissionHandlerParams = {
  admittedRunContext: AdmittedRunContext;
  agentId: string;
  sessionKey: string;
  /** Spawned children ask in their parent's conversation; other turns ask where they were sent. */
  route: { parentSessionKey?: string; fallback?: DeliveryContext };
  isActive?: () => boolean;
};

type ApprovalDecision = "allow-once" | "deny" | null | undefined;

/** Ingress supplies live run and route facts; native payloads supply display facts only. */
export function createAcpPermissionHandler(
  params: AcpPermissionHandlerParams,
): AcpManagerPermissionHandler {
  const admittedAuthority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  const pending = new Set<string>();
  return async (request, context) => {
    const requestLifetime = new AbortController();
    const signal = AbortSignal.any([context.signal, requestLifetime.signal]);
    const assertActive = () => {
      signal.throwIfAborted();
      context.assertActive?.();
      if (
        params.isActive?.() === false ||
        !admittedAuthority ||
        getAdmittedRunDelegatedAuthority(params.admittedRunContext) !== admittedAuthority
      ) {
        throw new Error("ACP permission request no longer has admitted run authority");
      }
    };
    let toolCallId: string | undefined;
    let ownsPending = false;
    try {
      assertActive();
      // Snapshot before asking: a retained/mutated adapter payload must never change the action
      // whose one-shot decision is returned. The native adapter owns option-ID translation.
      const raw = structuredClone(request.raw);
      toolCallId = raw.toolCall?.toolCallId?.trim();
      if (
        !toolCallId ||
        toolCallId.length > 512 ||
        request.sessionId !== raw.sessionId ||
        !Array.isArray(raw.options) ||
        !raw.options.some((option) => option.kind === "allow_once") ||
        pending.size >= MAX_PENDING_PERMISSIONS ||
        pending.has(toolCallId)
      ) {
        return CANCEL;
      }
      pending.add(toolCallId);
      ownsPending = true;
      const route = params.route.parentSessionKey
        ? await readAcpSpawnParentDeliveryContext({
            parentSessionKey: params.route.parentSessionKey,
            requesterAgentId: params.agentId,
            assertActive,
          })
        : params.route.fallback;
      assertActive();
      const identity = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: params.admittedRunContext,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        receiptAuthority: assertActive,
        approvalSignals: [signal],
        turnSourceChannel: route?.channel,
        turnSourceTo: route?.to,
        turnSourceAccountId: route?.accountId,
        turnSourceThreadId: route?.threadId,
      });
      if (!identity) {
        return CANCEL;
      }
      const withCaller = <T>(run: () => Promise<T>) => withGatewayToolCallerIdentity(identity, run);
      const title = raw.toolCall.title?.trim() || "ACP agent needs permission";
      const presentation = formatHarnessApprovalPresentation({
        title: redactSensitiveText(title),
        description: redactSensitiveText(
          [
            title,
            context.cwd ? `Working directory: ${context.cwd}` : undefined,
            raw.toolCall.rawInput === undefined
              ? undefined
              : `Requested input: ${JSON.stringify(raw.toolCall.rawInput)}`,
            raw.toolCall.locations?.length
              ? `Paths: ${raw.toolCall.locations.map((location) => location.path).join(", ")}`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      });
      const requested = await withCaller(
        async () =>
          await withGatewayToolApprovalOwner(
            context.backendId,
            async () =>
              await callGatewayTool<{ id?: string; decision?: ApprovalDecision }>(
                "plugin.approval.request",
                { timeoutMs: APPROVAL_TIMEOUT_MS + 5_000 },
                {
                  ...presentation,
                  severity: "warning",
                  toolName: `acp.${raw.toolCall.kind ?? request.inferredKind ?? "tool"}`,
                  toolCallId,
                  timeoutMs: APPROVAL_TIMEOUT_MS,
                  twoPhase: true,
                  allowedDecisions: ["allow-once", "deny"],
                },
                { expectFinal: false, requireAgentRuntimeIdentity: true, signal },
              ),
          ),
      );
      assertActive();
      if (!requested?.id || requested.decision === null) {
        return CANCEL;
      }
      const approvalId = requested.id;
      const decided = await withCaller(
        async () =>
          await callGatewayTool<{ id?: string; decision?: ApprovalDecision }>(
            "plugin.approval.waitDecision",
            { timeoutMs: APPROVAL_TIMEOUT_MS + 5_000 },
            { id: approvalId },
            { signal },
          ),
      );
      // An allowed decision is useful only while this exact admitted owner is still live.
      assertActive();
      if (decided?.id !== approvalId) {
        return CANCEL;
      }
      if (decided.decision === "allow-once") {
        return { outcome: "allow_once" };
      }
      return decided.decision === "deny" &&
        raw.options.some((option) => option.kind === "reject_once")
        ? { outcome: "reject_once" }
        : CANCEL;
    } catch {
      // No route, denial, timeout, disconnect, and stale/aborted owners must not fall through to
      // a backend's configured fallback permission mode (which may be approve-all).
      return CANCEL;
    } finally {
      requestLifetime.abort(new Error("ACP permission request settled"));
      if (ownsPending && toolCallId) {
        pending.delete(toolCallId);
      }
    }
  };
}
