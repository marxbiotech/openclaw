// Narrow plugin-sdk surface for the remote-acpx extension.
// Re-exports the ACP runtime backend surface (already exposed via
// plugin-sdk/acp-runtime-backend) plus the gateway↔node event bridge that
// only remote backends need.

export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../acp/runtime/registry.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeConfigOptionResult,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpSessionUpdateTag,
} from "@openclaw/acp-core/runtime/types";
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../plugins/types.js";

// Node event bridge — the piece a remote runtime uniquely needs.
export {
  registerAcpNodeEventHandler,
  unregisterAcpNodeEventHandler,
  sendAcpEventToNode,
  isAcpNodeConnected,
  listAcpNodes,
  resolveAcpNodeIdByName,
} from "../gateway/acp-node-event-bridge.js";
