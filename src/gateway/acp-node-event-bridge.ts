// Pub/sub singleton bridging the remote-acpx extension to node WebSocket events.
// The extension sends ACP commands to nodes via sendAcpEventToNode(),
// and receives responses via a registered handler from getAcpNodeEventHandler().
//
// State is stored on globalThis via Symbol.for() so that the gateway (bundled JS)
// and extensions (loaded as raw TS via tsx) share the same instance — without this,
// each module loader creates its own copy of the module-level variables.

// Extension → Node: send ACP events to Mac node
type AcpNodeSender = (nodeId: string, event: string, payload: unknown) => boolean;

// Node → Extension: receive ACP events from Mac node
type AcpNodeEventHandler = (nodeId: string, evt: { event: string; payload: unknown }) => void;

// Node name → nodeId resolution
type AcpNodeInfo = { nodeId: string; displayName?: string };
type AcpNodeListProvider = () => AcpNodeInfo[];

// Node connectivity check
type AcpNodeChecker = (nodeId: string) => boolean;

type AcpNodeEventBridgeState = {
  sender: AcpNodeSender | null;
  eventHandler: AcpNodeEventHandler | null;
  nodeListProvider: AcpNodeListProvider | null;
  nodeChecker: AcpNodeChecker | null;
};

const ACP_NODE_EVENT_BRIDGE_KEY = Symbol.for("openclaw.acpNodeEventBridgeState");

function resolveState(): AcpNodeEventBridgeState {
  const g = globalThis as typeof globalThis & {
    [ACP_NODE_EVENT_BRIDGE_KEY]?: AcpNodeEventBridgeState;
  };
  if (!g[ACP_NODE_EVENT_BRIDGE_KEY]) {
    g[ACP_NODE_EVENT_BRIDGE_KEY] = {
      sender: null,
      eventHandler: null,
      nodeListProvider: null,
      nodeChecker: null,
    };
  }
  return g[ACP_NODE_EVENT_BRIDGE_KEY];
}

// --- Sender ---

export function registerAcpNodeSender(sender: AcpNodeSender): void {
  resolveState().sender = sender;
}

export function unregisterAcpNodeSender(): void {
  resolveState().sender = null;
}

export function sendAcpEventToNode(nodeId: string, event: string, payload: unknown): boolean {
  const s = resolveState().sender;
  if (!s) {
    return false;
  }
  return s(nodeId, event, payload);
}

// --- Event handler ---

export function registerAcpNodeEventHandler(handler: AcpNodeEventHandler): void {
  resolveState().eventHandler = handler;
}

export function unregisterAcpNodeEventHandler(): void {
  resolveState().eventHandler = null;
}

export function getAcpNodeEventHandler(): AcpNodeEventHandler | null {
  return resolveState().eventHandler;
}

// --- Node list provider ---

export function registerAcpNodeListProvider(provider: AcpNodeListProvider): void {
  resolveState().nodeListProvider = provider;
}

export function unregisterAcpNodeListProvider(): void {
  resolveState().nodeListProvider = null;
}

export function resolveAcpNodeIdByName(displayName: string): string | null {
  const provider = resolveState().nodeListProvider;
  if (!provider) {
    return null;
  }
  const nodes = provider();
  const match = nodes.find((n) => n.displayName?.toLowerCase() === displayName.toLowerCase());
  return match?.nodeId ?? null;
}

// --- Node connectivity check ---

export function registerAcpNodeChecker(checker: AcpNodeChecker): void {
  resolveState().nodeChecker = checker;
}

export function unregisterAcpNodeChecker(): void {
  resolveState().nodeChecker = null;
}

export function listAcpNodes(): AcpNodeInfo[] {
  const provider = resolveState().nodeListProvider;
  return provider ? provider() : [];
}

export function isAcpNodeConnected(nodeId: string): boolean {
  const checker = resolveState().nodeChecker;
  if (!checker) {
    return false;
  }
  return checker(nodeId);
}
