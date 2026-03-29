// Narrow plugin-sdk surface for the remote-acpx extension.
// Re-exports AcpRuntime types from the acpx surface + the node event bridge.

// AcpRuntime types and registry (re-export from acpx surface)
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpSessionUpdateTag,
} from "../acp/runtime/types.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../plugins/types.js";

// Node event bridge (new for remote-acpx)
export {
  registerAcpNodeEventHandler,
  unregisterAcpNodeEventHandler,
  sendAcpEventToNode,
  isAcpNodeConnected,
  listAcpNodes,
  resolveAcpNodeIdByName,
} from "../gateway/acp-node-event-bridge.js";
