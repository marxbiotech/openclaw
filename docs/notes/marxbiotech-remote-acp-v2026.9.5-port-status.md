# marxbiotech/remote-acp port onto upstream v2026.9.5 — status

Branch: `marxbiotech/v2026.9.5-remote-acp`
Base: upstream tag `v2026.9.5` (commit `ec9c1a13db8`)
Source of fork work: `marxbiotech/remote-acp` (commit `eec7f18fc95`, "build(release): bump fork version to 2026.7.1-beta.9 (ai pin preserved)")
Recovery baseline: `backup/remote-acp-before-2026.7.1-20260922` (preserved, not modified)

## Status

**Port is UNFINISHED.** This branch currently contains only this status note on top of pristine `v2026.9.5`. A prior working-tree merge attempt was aborted after reconnaissance revealed that the fork's remote-acp/remote-acpx design predates a substantial upstream re-architecture of the ACP runtime backend. A mechanical port is not viable; the work needs to be reimplemented against upstream's new interfaces.

## Scope

Fork delta versus `v2026.7.1`:

- 292 files changed, ~3,808 insertions / 1,521 deletions.
- 178 fork commits after `--cherry-pick` equivalence filtering.
- 6 files added by the fork; 5 remain fork-only in v2026.9.5.
  Upstream now ships `src/plugins/install-npm-resolution.ts` independently.

## Merge preview against `v2026.9.5` (aborted)

`git merge --no-commit --no-ff marxbiotech/remote-acp` produced **812 conflict markers**:

|                                        Kind | Count |
| ------------------------------------------: | ----- |
|                  UU (both modified content) | 649   |
|     DU (deleted upstream, modified in fork) | 119   |
| AA (added on both sides, differing content) | 44    |

## Upstream churn on fork-critical files (v2026.7.1 → v2026.9.5)

Commit counts touching each hot path:

- `packages/gateway-protocol/src/schema/sessions.ts` — 72
- `src/gateway/server.impl.ts` — 58
- `src/node-host/runner.ts` — 50
- `src/gateway/session-utils.ts` — 50
- `src/config/zod-schema.agent-runtime.ts` — 34
- `src/agents/tools/sessions-list-tool.ts` — 27
- `extensions/acpx/package.json` — 24
- `src/plugin-sdk/api-baseline.ts` — 16
- `src/agents/acp-spawn.ts` — 14
- `src/config/types.agents.ts` — 12
- `src/acp/control-plane/manager.initialize-session.ts` — 7
- `src/plugins/install.ts` — 6

## Architectural blocker

Upstream v2026.9.5 has introduced a first-class ACP runtime backend registry that did not exist at v2026.7.1. The fork's `src/plugin-sdk/remote-acpx.ts` and its supporting node-host/gateway plumbing were designed against the older direct-invocation shape and no longer align with the new surface.

New upstream modules that supersede or reshape the fork's design:

- `src/acp/runtime/registry.ts` (`registerAcpRuntimeBackend` / `requireAcpRuntimeBackend`)
- `src/acp/runtime/errors.ts` (`AcpRuntimeError`, `AcpRuntimeErrorCode`)
- `src/acp/runtime/session-meta*.ts` (session-meta store, doctor, legacy migration, readonly)
- `src/acp/runtime/session-control-owner.ts`
- `src/acp/runtime/availability.ts`
- `src/plugin-sdk/acp-runtime-backend.ts` (compat facade for released `@openclaw/acpx` packages)
- `src/plugin-sdk/acp-runtime.ts` (public helpers: `resolveAcpSessionAvailability`, `readAcpSessionEntry`, ...)
- `src/plugin-sdk/acpx.ts` (backend-private dispatch: `tryDispatchAcpReplyHook`, deny-policy handling)

Upstream also removed `src/plugin-sdk/entrypoints.ts` (fork edited it) in favour of the new module split.

## Recommended path forward

1. Treat this as a **re-integration**, not a rebase.
   The fork's remote-acp/remote-acpx capability should be recast as an implementation of upstream's `AcpRuntime` backend and registered via `registerAcpRuntimeBackend`.
2. Split the port into focused PRs:
   - **PR-A (release plumbing)**: reapply the `@marxbiotech/*` package rename, `mb*` release flow, extension shrinkwrap regeneration, `scripts/openclaw-npm-*` adaptations. Mechanical; use `4e3f9dac4ec chore: reapply mb* release flow on 2026.7.1` as the model.
   - **PR-B (core remote-acpx backend)**: implement remote-acpx as an `AcpRuntimeBackend` using the new registry; wire node-side dispatch through the new `AcpRuntimeCapabilities` shape; adapt `src/node-host/invoke-acp.ts` to the new session-meta store.
   - **PR-C (gateway/session integration)**: reapply the fork edits to `src/gateway/session-utils.ts`, `server.impl.ts`, `agents/tools/sessions-list-tool.ts` on top of the new upstream shape (nodeName affinity, cwd filtering, ACP node-event bridge).
   - **PR-D (auxiliary edits)**: extension patches (`extensions/codex/*`, `extensions/memory-core/*`, `extensions/diagnostics-otel/*`), infra migrations (`state-migrations.ts`, `install-source-utils.ts`), private-mode / update-runner.
3. Preserve `marxbiotech/remote-acp` unchanged as the recovery baseline until at least PR-B is deployed to a persona and verified.

## Deployment consequences (not addressed by this branch)

Per `docs/openclaw-2026.7.1-upgrade-runbook.md` (in `moltbot-env`), the last major port required schema migration, live-PVC strip, ambiguous-session-key handling, `doctor --fix` auto auth-import, crashloop-vs-atomic timeout tuning, and node LaunchAgent reinstall. Expect at least the same depth here, plus new steps for the ACP session-meta store migration (`src/acp/runtime/session-meta.legacy-migration.test.ts` is a hint).

## Files considered but not applied

The following fork-only additions were previewed but left unstaged because they do not compile against upstream's new plugin-sdk / gateway surface:

- `src/gateway/acp-node-event-bridge.ts`
- `src/node-host/invoke-acp.ts`
- `src/node-host/invoke-acp.test.ts`
- `src/plugin-sdk/remote-acpx.ts`
- `docs/technical/session-node-affinity.md` (fork-only, and the fork's `docs/technical/` directory does not exist in upstream; the doc semantics need re-evaluation against the new session-meta store)

All are available at their fork revisions on `marxbiotech/remote-acp` for reference during the re-integration work.
