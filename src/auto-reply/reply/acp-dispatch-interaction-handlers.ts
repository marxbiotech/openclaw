import { createLazyAcpPermissionHandler } from "../../acp/control-plane/permission-handler-lazy.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { createLazyAcpElicitationHandler } from "./acp-elicitation-handler-lazy.js";
import type { AcpElicitationHandlerParams } from "./acp-elicitation-handler.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";

/** Builds the turn-owned user-input and native-permission relays for one bound ACP turn. */
export function createAcpDispatchInteractionHandlers(
  ctx: FinalizedRuntimeMsgContext,
  admittedRunContext: AdmittedRunContext,
  params: AcpElicitationHandlerParams,
) {
  return {
    onElicitation: createLazyAcpElicitationHandler(params),
    // A bound conversation's operator is in this inbound route, so ask here.
    onNativePermissionRequest: createLazyAcpPermissionHandler({
      admittedRunContext,
      agentId: params.agentId,
      sessionKey: params.targetSessionKey,
      route: {
        fallback: normalizeDeliveryContext({
          ...resolveEffectiveReplyRoute({ ctx }),
          threadId: resolveRoutedDeliveryThreadId({ ctx, sessionKey: params.sourceSessionKey }),
        }),
      },
      isActive: params.isActive,
    }),
  };
}
