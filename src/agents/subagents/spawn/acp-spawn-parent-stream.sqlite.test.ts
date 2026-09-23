import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { drainSystemEvents } from "../../../infra/system-events.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { listAcpParentStreamEventsForTest } from "./acp-parent-stream-store.sqlite.test-support.js";
import { startAcpSpawnParentStreamRelay } from "./acp-spawn-parent-stream.js";

describe("ACP parent stream session database ownership", () => {
  it("continues parent progress when the diagnostic store cannot be resolved", async () => {
    await withOpenClawTestState({ label: "acp-stream-unreadable" }, async (state) => {
      const blocker = await state.writeText("not-a-directory", "blocker");
      const parentSessionKey = "agent:main:main";
      const runId = "unreadable-run";
      const relay = startAcpSpawnParentStreamRelay({
        runId,
        parentSessionKey,
        childSessionKey: "agent:codex:acp:child",
        childSessionId: "child-session",
        childSessionStorePath: `${blocker}/sessions`,
        agentId: "codex",
        env: state.env,
        emitStartNotice: false,
      });
      try {
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "Version checked." } });
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        expect(drainSystemEvents(parentSessionKey)).toEqual([
          "codex: Version checked.",
          "codex run completed.",
        ]);
        expect(
          existsSync(resolveOpenClawAgentSqlitePath({ agentId: "codex", env: state.env })),
        ).toBe(false);
      } finally {
        relay.dispose();
      }
    });
  });

  it.each(["default", "custom", "shared"] as const)(
    "keeps delayed diagnostics with the child in a %s store",
    async (kind) => {
      await withOpenClawTestState({ label: "acp-stream-owner" }, async (state) => {
        const agentId = "codex";
        const sessionId = "child-session";
        const sessionKey = "agent:codex:acp:child";
        const runId = "child-run";
        const storePath = resolveSessionStorePathCore(
          kind === "default"
            ? undefined
            : state.statePath(kind === "shared" ? "shared.sqlite" : "sessions"),
          { agentId, env: state.env },
        );
        // An exact shared locator is physically owned by main, even for a codex child.
        if (kind === "shared") {
          await upsertSessionEntryCore(
            { agentId: "main", env: state.env, storePath, sessionKey: "agent:main:main" },
            { sessionId: "parent-session", updatedAt: 1 },
          );
        }
        await upsertSessionEntryCore(
          { agentId, env: state.env, storePath, sessionKey },
          { sessionId, updatedAt: 1 },
        );
        const target = resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId,
          env: state.env,
        });
        const relayEnv = { ...state.env };
        const params = {
          runId,
          parentSessionKey: "agent:main:main",
          childSessionKey: sessionKey,
          childSessionId: sessionId,
          childSessionStorePath: storePath,
          agentId,
          env: relayEnv,
          emitStartNotice: false,
          surfaceUpdates: false,
        };
        const relay = startAcpSpawnParentStreamRelay(params);
        try {
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "Version checked." } });
          // A buffered flush must retain the admitted store despite later caller changes.
          params.childSessionStorePath = state.statePath("replacement");
          relayEnv.OPENCLAW_STATE_DIR = state.path("replacement-state");
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          const events = listAcpParentStreamEventsForTest({
            agentId: target.agentId ?? agentId,
            path: target.path,
            env: state.env,
            sessionId,
            runId,
          });
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "assistant_delta",
                delta: "Version checked.",
                agentId,
              }),
              expect.objectContaining({ kind: "lifecycle", phase: "end", agentId }),
            ]),
          );
          if (kind !== "default") {
            expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId, env: state.env }))).toBe(
              false,
            );
          }
          expect(existsSync(state.path("replacement-state"))).toBe(false);
        } finally {
          relay.dispose();
        }
      });
    },
  );
});
