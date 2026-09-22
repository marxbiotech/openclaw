# Remote ACP on upstream v2026.9.5 — design decision and status

Branch: `marxbiotech/v2026.9.5-remote-acp`
Base: upstream tag `v2026.9.5` (`ec9c1a13db8`)
PR: [marxbiotech/openclaw#7](https://github.com/marxbiotech/openclaw/pull/7)
Legacy release reference: `marxbiotech/v2026.7.1-remote-acpx` (`eec7f18fc95`)

## Accepted scope — 2026-09-22

Build remote ACP against the architecture available in upstream v2026.9.5.
The operator explicitly permits discarding the legacy implementation and its
compatibility requirements. Existing releases provide legacy behavior until
this version is complete.

The required product capability is:

> An agent running through the Gateway can direct acpx on a paired node and
> receive its execution results, with the workspace and harness execution on
> that node.

Preserve that delegation workflow. Legacy tool names, configuration shapes,
SDK exports, event names, internal data formats, and implementation structure
are not acceptance requirements. The new implementation does not need legacy
fallbacks, dual execution paths, or migration of old plugin sessions and jobs.
Unrelated fork patches and release customizations need a concrete requirement
for the new version before being carried forward.

This decision does not authorize deleting deployment data or changing running
Gateways or nodes. Deployment and upstream state upgrades are separate work.

## Current status

**Implementation is incomplete.** Commit `11e2c0fe7f3` captured preliminary
node event bridging, process handling, an SDK facade, node affinity plumbing,
and cwd filtering. PR #7 is a draft containing that snapshot.

The snapshot is reference material, not a required starting implementation.
Replace or remove its additions when the selected upstream interfaces cover
their responsibilities. Completing the old bridge is not a project requirement.

The previous note incorrectly said the ACP backend registry was introduced
following v2026.7.1. Both the registry and backend SDK already existed, and the
legacy remote-acpx plugin already registered an `AcpRuntime` backend. The new
design concerns transport, state ownership, and current runtime contracts.

## Proposed architecture

1. **Gateway control plane:** Use existing ACP/session/task owners for admission,
   conversation state, turn lifecycle, cancellation, and delivery.
2. **Gateway plugin:** Implement a remote `AcpRuntime` adapter through public SDK
   interfaces. Resolve a paired-node target and retain its stable identity for
   the session.
3. **Transport:** Use `api.runtime.nodes.invoke` for bounded operations and
   `api.runtime.nodes.openDuplex` for streamed interactions. Register the same
   plugin-owned duplex command on the Gateway and node.
4. **Node plugin:** Own local runtime execution and process cleanup through
   `registerNodeHostCommand`, including availability and disconnect lifecycle.
   Prefer the published `acpx/runtime` interface over duplicated CLI protocol
   parsing, subject to node-side execution validation.
5. **State:** Keep conversation and task state with existing OpenClaw owners.
   Remote handles and node-local acpx session resources remain backend-owned.
   Avoid a second conversation/job manager with independent TTL and completion
   rules.

One plugin package can supply both host roles. Its existing internals may be
replaced completely. Limit core changes to demonstrated gaps in the new
workflow; zero core changes remains a hypothesis to verify.

Relevant upstream contracts:

- [ACP agents](/tools/acp-agents)
- [Plugin Gateway and node runtime](/plugins/sdk-runtime/gateway-and-nodes)
- `src/plugin-sdk/acp-runtime.ts`
- `packages/acp-core/src/runtime/types.ts`
- `src/plugins/types.node-host.ts`

## Proposed acceptance checks

- A Gateway agent starts acpx work in the requested workspace on the selected
  paired node and receives progress, a terminal result, and actionable errors.
- Follow-up work uses the intended conversation and node. An unavailable target
  never silently redirects work to the Gateway or another node.
- Cancellation reaches the active remote turn and reports its actual outcome;
  late events from an earlier turn cannot settle or cancel its successor.
- Long turns use appropriate execution budgets and upstream transport heartbeat
  behavior.
- Restart and disconnect behavior is explicit. Duplex channels cannot survive
  disconnection; recovery must reconcile the original execution before replaying
  a prompt that may already have started.
- Pairing, command policy, and execution authorization work for the actual custom
  plugin installation, without assuming privileged scope elevation or automatic
  session-full approval authority.

Continuing active work while disconnected is not provided by the transport and
is not an inherited compatibility requirement. If needed, specify it separately
with node-owned execution records and reconciliation.

## Next checkpoint

Prove a minimal Gateway-plugin to paired-node-plugin round trip on stock
v2026.9.5, including actual acpx execution, output, cancellation, long-running
work, and disconnect handling. Use the evidence to finalize the adapter boundary,
integrate the standard ACP agent flow, and remove superseded fork plumbing.

Analysis so far is based on source and contract inspection. Runtime, end-to-end,
upgrade, and deployment readiness have not been established.
