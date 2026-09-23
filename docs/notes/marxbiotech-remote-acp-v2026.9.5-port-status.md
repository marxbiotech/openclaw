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

Commit `341913ee43e` reverted the preliminary port in `11e2c0fe7f3`. The custom
node event bridge, core process runner, remote-acpx SDK facade, nodeName plumbing,
and unrelated cwd filtering are removed. Existing branch history retains the
snapshot for reference.

The replacement lives in `moltbot-app/image-extensions/remote-acpx` on branch
`feat/remote-acpx-v2026.9.5`. It implements an owner-aware ACP backend, stable
node affinity, upstream duplex transport, node-owned workers using
`acpx@0.16.0`, cancellation, elicitation, and persistent session resumption.
The legacy plugin tools, roster, event router, session manager, and job store
are removed. Node execution currently supports macOS and Linux.

The public `openclaw/plugin-sdk/acp-backend` contract exposes
the canonical backend types, existing registry, errors, and lazy reply hook.
The bundled ACPX plugin now consumes the same contract. The upstream
`acp-runtime` and `process-runtime` facades are explicitly classified as private;
the former being packaged does not make it a supported typed external API.
The new plugin uses no private runtime facade.
The node host also exposes an optional, closure-bound
`prepareConfiguredExecAuthorization()` capability for operator-configured
execution. It reuses the canonical node policy and approval floor; an older host
without this capability rejects that mode.

The previous note incorrectly said the ACP backend registry was introduced
following v2026.7.1. Both the registry and backend SDK already existed, and the
legacy remote-acpx plugin already registered an `AcpRuntime` backend. The new
design concerns transport, state ownership, and current runtime contracts.

## Implemented architecture

1. **Gateway control plane:** Use existing ACP/session/task owners for admission,
   conversation state, turn lifecycle, cancellation, and delivery.
2. **Gateway plugin:** Implement a remote `AcpRuntime` adapter through public SDK
   interfaces. Resolve a paired-node target and retain its stable identity for
   the session.
3. **Transport:** Use `api.runtime.nodes.openDuplex` for controls and streamed
   interactions. Register the same
   plugin-owned duplex command on the Gateway and node.
4. **Node plugin:** Own local runtime execution and process cleanup through
   `registerNodeHostCommand`, including availability and disconnect lifecycle.
   Use the published `acpx/runtime` interface inside a node-owned worker. Retain
   the worker across session initialization and setup until the first turn so
   providers that persist only after a prompt keep their new session alive.
   Call the live execution guard immediately before spawning or reusing a
   worker. Turns and terminal operations join runtime cleanup and worker exit
   before publishing the result; disconnect also drains retained setup workers.
5. **State:** Keep conversation and task state with existing OpenClaw owners.
   Remote handles and node-local acpx session resources remain backend-owned.
   Avoid a second conversation/job manager with independent TTL and completion
   rules.

One plugin package supplies both host roles. Core owns conversation/task state;
the plugin owns execution adapters. Core changes supply the public backend
registration contract and a generic configured execution guard.

Relevant upstream contracts:

- [ACP agents](/tools/acp-agents)
- [Plugin Gateway and node runtime](/plugins/sdk-runtime/gateway-and-nodes)
- `src/plugin-sdk/acp-backend.ts`
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

## Validation and delivery

- The full OpenClaw build passes with the public backend declarations included.
- The focused SDK and migrated bundled ACPX tests pass (15 tests), and the SDK
  TypeScript test shard passes.
- The plugin typechecks against the built fork and its process/integration tests
  pass (34 tests). They exercise actual acpx against a synthetic ACP harness,
  including registered plugin routing, persisted follow-up, explicit and signal
  cancellation, elicitation, ownership, stale handles, and descendant cleanup.
  Regressions cover providers that persist only on their first prompt, fresh
  execution authority when reusing a worker, and stale-close isolation.
- The node-host contract tests pass (60 tests), including configured full/off
  policy, the canonical approvals floor, owner-specific restrictions, guard
  closure, and late policy changes. Core TypeScript and SDK export checks pass.
- A clean production-only npm install succeeds without the sibling development
  checkout. The plugin needs the matching fork build at runtime.

The isolated live Gateway/node test also passes: actual device and command
pairing, captured plugin loading, five real plugin approvals, node-local cwd,
streamed output, persistent follow-up, a silent 35-second turn through upstream
heartbeats, acknowledged cancellation, and bidirectional elicitation. It uses a
synthetic ACP peer and temporary state; no provider credentials are needed.
A second live check initializes canonical ACP metadata through the host manager,
sends a real `chat.send` turn, waits through `agent.wait`, and verifies the
manager returns to idle with the prompt recorded by the node-local peer.
Existing deployed Gateways/nodes and data are untouched.

The default `executionApproval: "always"` requests Allow once for execution.
Operators can select `node-policy` on the Gateway to authorize agent-driven
execution on the current configured target. The node independently requires
effective `security: "full"` and `ask: "off"` in its configuration and canonical
approvals floor. Each spawn or retained-worker use gets a fresh live guard.
Cancellation of admitted work does not prompt again. ACP harness permission
mode is independent and does not grant OpenClaw execution authority. No fake
Full authority, scope elevation, or standing approval cache is introduced.

The plugin packages the model-visible `remote-acp-router` skill. A separate live
proof uses a deterministic model peer with a real Gateway and paired node:
the model reads that skill, calls `sessions_spawn(runtime="acp", mode="run")`,
executes acpx on the node, and summarizes completion in the parent conversation
with zero per-operation approvals. The ACP executor is registered in the current
agent roster. This proves the actual agent-tool and parent-delivery path without
requiring user slash commands; it does not measure a provider model's routing
judgment. The original approval-based live proof still passes.

One-shot runs close their native harness session. The skill requires full prior
context for later work and does not promise native continuity by reusing a
completed run's key. Persistent context uses a supported ACP child thread.
Image smoke checks verify the skill is eligible, model-visible, and not a
user-invocable slash command. The beta.2 host/application images below include
the authorization capability and packaged skill; beta.1 predates them.

The matching base image is published as
`ghcr.io/marxbiotech/openclaw:mb2026.9.5-beta.2`, from commit
`3e458dbc5b912d8363ec5862d164949e2e379651`. Its multi-platform digest is
`sha256:d6265781a4d44ad2babbd54982d1591ff1822ffe8cc46675bf4b6de8193b69cc`.
The [image release run](https://github.com/marxbiotech/openclaw/actions/runs/35712885442)
passed native amd64 and arm64 runtime checks for the host version, source commit,
public backend SDK, and image attestations. Registry readback confirms both
architectures and the source identity. The host package version remains
`2026.9.5`; the image tag identifies the fork's beta release.

The fork-specific `marxbiotech-docker-release.yml` workflow publishes lightweight
`mbYYYY.M.D-beta.N` tags to GHCR. It retains the `docker-release` environment,
publishes the multi-platform version tag only after both architecture checks,
and refuses to overwrite an existing version tag.

The application Dockerfile now pins this base. Its image tags derive from the
OpenClaw image version plus the application commit, and its Docker build checks
actual remote-acpx registration, skill discovery, and worker imports as the
non-root runtime user. The application image is published as
`ghcr.io/marxbiotech/moltbot-app:mb2026.9.5-beta.2-667b525`, from commit
`667b5253d564524a01c2abd147b16d4c3dea6f2b`, with multi-platform digest
`sha256:f747fc92d8c87191cb18c67de3136c8a217680efde3f9a69e20429b2a10bb2bd`.
The [application image run](https://github.com/marxbiotech/moltbot-app/actions/runs/35715406009)
passed amd64 and arm64 checks. Registry readback confirms both variants
retain the corresponding pinned OpenClaw base layers.

On 2026-09-22, the beta.2 application image passed the agent-owned path in an
isolated ARM64 Kubernetes Pod, paired with a temporary node on a physical macOS
host. A deterministic Gateway model peer read the image's packaged skill and
called the actual `sessions_spawn` tool. Real Claude then created a requested
file in the node's temporary workspace, and the core delivered completion to
the coordinating agent. The child transcript, exact file contents, parent reply,
and absence of per-operation approvals were verified. Provider login stayed in
the temporary node process environment. The image pulled in about 87 seconds.
The same configured-policy path also passed local isolated Claude reply and
file-write runs; their temporary state was removed with no process retaining the
test working directories.

Earlier beta.1 verification used the same isolated Kubernetes/macOS topology.
Cross-machine
checks passed for approvals, cwd, streaming, persisted follow-up, the silent
35-second turn, cancellation, elicitation, and canonical manager admission.
Two real Claude turns also passed through `chat.send`, `agent.wait`, the
canonical ACP manager, and the paired node; the second turn recalled the first
reply, and both returned the manager to idle. Provider login remained only in
the temporary node process environment. The test-only manager ingress uses the
current request config, matching normal chat admission after startup changes.

The Kubernetes proof used port-forwarding and temporary state. It does not prove
an upgrade of existing data or the deployed network route. Production Pod
identity, images, readiness, and restart counts were unchanged, and test
resources were removed. The first cold image pull took about 24 minutes and
briefly triggered node disk pressure before automatic recovery; deployment
planning must account for image storage and pull time. Publishing these images
does not upgrade existing Gateways, paired nodes, or live data.
