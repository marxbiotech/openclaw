import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("subagent terminal timing write admission", () => {
  it.each(["duplicate", "replacement"] as const)(
    "settles a queued timing write after %s completion ownership changes",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { session: { store: state.statePath("sessions") } };
        setRuntimeConfigSnapshot(cfg);
        const childSessionKey = "agent:grok:acp:timing-race";
        const target = {
          agentId: "grok",
          sessionKey: childSessionKey,
          storePath: resolveSessionStorePathCore(cfg.session.store, { agentId: "grok" }),
        };
        await upsertSessionEntryCore(target, {
          sessionId: "timing-race-session",
          updatedAt: 1_000,
          status: "running",
        });
        const originalSession = loadSessionEntry(target);
        const entry: SubagentRunRecord = {
          runId: "timing-race-run",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "answer the version question",
          cleanup: "keep",
          generation: 1,
          createdAt: 1_000,
          execution: { status: "running", startedAt: 2_000 },
        };
        const runs = new Map([[entry.runId, entry]]);
        const warn = vi.fn();
        const retireSupersededRun = vi.fn(async () => {});
        const controller = new SubagentLifecycleController({
          runs,
          resumedRuns: new Set(),
          subagentAnnounceTimeoutMs: 1_000,
          getRuntimeConfig: () => cfg,
          persist: () => {},
          persistOrThrow: () => {},
          clearPendingLifecycleError: () => {},
          countPendingDescendantRuns: () => 0,
          getLatestRunForChildSession: (key, matches) =>
            getLatestSubagentRunByChildSessionKeyFromRuns(runs, key, matches) ?? null,
          suppressAnnounceForSteerRestart: () => false,
          resolveSubagentTask: () => ({ lookup: "available" }),
          shouldEmitEndedHookForRun: () => false,
          emitSubagentEndedHookForRun: async () => {},
          emitSubagentProgressEndedForRun: async () => {},
          notifyContextEngineSubagentEnded: async () => {},
          retireSupersededRun,
          resumeSubagentRun: () => {},
          callGateway: async () => {
            throw new Error("Unexpected Gateway call during timing persistence");
          },
          captureSubagentCompletionReply: async () => "Version checked.",
          cleanupBrowserSessionsForLifecycleEnd: async () => {},
          runSubagentAnnounceFlow: async () => "delivered",
          maybeWakeRequesterAfterAllChildrenSettled: async () => false,
          warn,
        });
        const releaseWriter = createDeferredCore();
        const writerEntered = createDeferredCore();
        const heldWriter = runExclusiveSqliteSessionWrite(
          resolveSqliteScope(target),
          async () => {
            writerEntered.resolve();
            await releaseWriter.promise;
          },
          "session.transcript.batch",
        );
        const complete = () =>
          controller.completeSubagentRun({
            runId: entry.runId,
            endedAt: 4_000,
            outcome: { status: "ok" },
            reason: SUBAGENT_ENDED_REASON_COMPLETE,
            triggerCleanup: false,
          });
        const completions: Promise<void>[] = [];
        try {
          await writerEntered.promise;
          completions.push(complete());
          await vi.waitFor(() =>
            expect(controller.isTerminalCallbackCurrent(entry.runId, entry, 1)).toBe(true),
          );
          if (change === "duplicate") {
            // Listener and agent.wait settle the same run while its timing write waits.
            completions.push(complete());
            await vi.waitFor(() =>
              expect(controller.isTerminalCallbackCurrent(entry.runId, entry, 2)).toBe(true),
            );
          } else {
            runs.set("replacement-run", {
              ...entry,
              runId: "replacement-run",
              generation: 2,
              createdAt: 5_000,
              execution: { status: "running", startedAt: 5_000 },
            });
          }
        } finally {
          releaseWriter.resolve();
          await heldWriter;
          await Promise.all(completions);
        }

        expect(warn).not.toHaveBeenCalled();
        if (change === "duplicate") {
          expect(loadSessionEntry(target)).toMatchObject({
            status: "done",
            startedAt: 2_000,
            endedAt: 4_000,
            runtimeMs: 2_000,
          });
          expect(retireSupersededRun).not.toHaveBeenCalled();
        } else {
          expect(loadSessionEntry(target)).toEqual(originalSession);
          expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
        }
      });
    },
  );
});
