/** Adapts unresolved native ACP permissions to the existing run-bound approval owner. */
import type { AcpPermissionHandler } from "@openclaw/acp-core/runtime/types";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { createRunApprovalCapability } from "../../agents/harness/host-approval.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";

const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PENDING_PERMISSIONS = 32;

function approvalDisplayText(value: string, limit: number): string {
  const redacted = redactSensitiveText(value);
  return redacted.length <= limit ? redacted : `${truncateUtf16Safe(redacted, limit - 1)}…`;
}

/** The manager supplies live run/session facts; native payloads supply display facts only. */
export function createAcpPermissionHandler(params: {
  admittedRunContext: AdmittedRunContext;
  backendId: string;
  agentId: string;
  sessionKey: string;
  cwd?: string;
  signal: AbortSignal;
  assertActive: () => void;
  getDeliveryContext: () => DeliveryContext | undefined;
}): AcpPermissionHandler {
  const admittedAuthority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  const pending = new Set<string>();
  return async (request, context) => {
    const requestLifetime = new AbortController();
    const signal = AbortSignal.any([params.signal, context.signal, requestLifetime.signal]);
    const assertActive = () => {
      signal.throwIfAborted();
      params.assertActive();
      if (
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
      if (!admittedAuthority) {
        return { outcome: "cancel" };
      }
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
        return { outcome: "cancel" };
      }
      pending.add(toolCallId);
      ownsPending = true;
      const route = params.getDeliveryContext();
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
      const approval = createRunApprovalCapability({
        pluginId: params.backendId,
        agentId: params.agentId,
        delegatedAuthority: admittedAuthority,
        assertActive,
        withCaller: (run) => withGatewayToolCallerIdentity(identity, run),
      });
      const title = raw.toolCall.title?.trim() || "ACP agent needs permission";
      const description = [
        title,
        params.cwd ? `Working directory: ${params.cwd}` : undefined,
        raw.toolCall.rawInput === undefined
          ? undefined
          : `Requested input: ${JSON.stringify(raw.toolCall.rawInput)}`,
        raw.toolCall.locations?.length
          ? `Paths: ${raw.toolCall.locations.map((location) => location.path).join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      const requested = await approval.requestApproval({
        title: approvalDisplayText(title, 80),
        description: approvalDisplayText(description, 512),
        severity: "warning",
        toolName: `acp.${raw.toolCall.kind ?? request.inferredKind ?? "tool"}`,
        toolCallId,
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: APPROVAL_TIMEOUT_MS,
        transportTimeoutMs: APPROVAL_TIMEOUT_MS + 5_000,
        signal,
      });
      assertActive();
      if (!requested?.id || requested.decision === null) {
        return { outcome: "cancel" };
      }
      const decided = await approval.waitForApproval({
        approvalId: requested.id,
        timeoutMs: APPROVAL_TIMEOUT_MS,
        transportTimeoutMs: APPROVAL_TIMEOUT_MS + 5_000,
        signal,
      });
      assertActive();
      if (decided?.decision === "allow-once") {
        return { outcome: "allow_once" };
      }
      return {
        outcome:
          decided?.decision === "deny" &&
          raw.options.some((option) => option.kind === "reject_once")
            ? "reject_once"
            : "cancel",
      };
    } catch {
      // No route, denial, timeout, disconnect, and stale/aborted owners must not fall through to
      // acpx's configured fallback permission mode (which an operator may have set to approve-all).
      return { outcome: "cancel" };
    } finally {
      requestLifetime.abort(new Error("ACP permission request settled"));
      if (ownsPending && toolCallId) {
        pending.delete(toolCallId);
      }
    }
  };
}
