// Narrow plugin-sdk surface for the bundled claude-node plugin.
// Keep this list additive and scoped to symbols used under extensions/claude-node.

export type { AnyAgentTool, OpenClawPluginApi, PluginLogger } from "../plugins/types.js";
export {
  callGatewayTool,
  readGatewayCallOptions,
  type GatewayCallOptions,
} from "../agents/tools/gateway.js";
export { resolveNodeId } from "../agents/tools/nodes-utils.js";
