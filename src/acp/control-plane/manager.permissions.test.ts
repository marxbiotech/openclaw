import type { AcpPermissionHandler } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { withAcpManagerTaskStateDir } from "../../../test/helpers/acp-manager-task-state.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";
import * as permissionRuntime from "./permission-handler.js";

vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

describe("ACP manager native permission composition", () => {
  installAcpSessionManagerTestLifecycle();

  it.each(["factory", "handler"])(
    "cancels if the permission %s rejects before a decision",
    async (failure) => {
      const runtime = createRuntime();
      const sessionKey = "agent:codex:acp:permission-error";
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtime.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockReturnValue({
        sessionKey,
        storeSessionKey: sessionKey,
        acp: readySessionMeta(),
      });
      const factory = vi
        .spyOn(permissionRuntime, "createAcpPermissionHandler")
        .mockImplementation(() => {
          if (failure === "factory") {
            throw new Error("approval runtime unavailable");
          }
          return async () => {
            throw new Error("approval transport failed");
          };
        });
      runtime.runTurn.mockImplementationOnce(async function* (input) {
        expect(input.onPermissionRequest).toBeTypeOf("function");
        await expect(
          input.onPermissionRequest!(
            {
              sessionId: "native",
              inferredKind: "execute",
              raw: { sessionId: "native", toolCall: { toolCallId: "tool" }, options: [] },
            },
            { signal: new AbortController().signal },
          ),
        ).resolves.toEqual({ outcome: "cancel" });
        yield { type: "done", status: "completed" };
      });
      try {
        await new AcpSessionManager().runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey,
          text: "test",
          mode: "prompt",
          requestId: `error-${failure}`,
        });
      } finally {
        factory.mockRestore();
      }
    },
  );

  it("gives a spawned child the current parent approval route and closes retained callbacks", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const child = "agent:codex:acp:permission-child";
      const parent = "agent:main:discord:channel:parent";
      let parentTo = "channel:old-parent";
      const runtime = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtime.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((input: { sessionKey: string }) => {
        if (input.sessionKey === child) {
          return {
            sessionKey: child,
            storeSessionKey: child,
            entry: {
              sessionId: "child-id",
              updatedAt: 1,
              spawnedBy: parent,
              createdVia: "spawn",
              createdActor: { type: "agent", id: "main" },
            },
            acp: readySessionMeta(),
          };
        }
        if (input.sessionKey === parent) {
          return {
            sessionKey: parent,
            storeSessionKey: parent,
            entry: {
              sessionId: "parent-id",
              updatedAt: 1,
              delivery: {
                kind: "external",
                context: { channel: "discord", to: parentTo, threadId: "thread" },
              },
            },
          };
        }
        return null;
      });
      const request = {
        sessionId: "native",
        inferredKind: "edit",
        raw: {
          sessionId: "native",
          toolCall: { toolCallId: "edit-1", title: "Edit README" },
          options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
        },
      };
      const native = new AbortController();
      let retained: AcpPermissionHandler | undefined;
      const callers: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
      vi.mocked(callGatewayTool).mockImplementation(async (method) => {
        callers.push(getGatewayToolCallerIdentity());
        return method === "plugin.approval.request"
          ? { id: "plugin:child" }
          : { id: "plugin:child", decision: "allow-once", terminalReason: "user" };
      });
      runtime.runTurn.mockImplementationOnce(async function* (input) {
        retained = input.onPermissionRequest;
        parentTo = "channel:current-parent";
        expect(retained).toBeTypeOf("function");
        await expect(retained!(request, { signal: native.signal })).resolves.toEqual({
          outcome: "allow_once",
        });
        yield { type: "done", status: "completed" };
      });
      const admission = prepareSystemAgentRunAdmission(
        baseCfg,
        "permission-child-run",
        "codex",
        "test",
      );
      try {
        await new AcpSessionManager().runTurn({
          admittedRunContext: await admission.admit("acp"),
          provenance: "agent",
          cfg: baseCfg,
          sessionKey: child,
          text: "Edit the README",
          mode: "prompt",
          requestId: "permission-child-run",
        });
        expect(callers[0]).toMatchObject({
          sessionKey: child,
          agentId: "codex",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:current-parent",
          turnSourceThreadId: "thread",
        });
        await expect(retained!(request, { signal: native.signal })).resolves.toEqual({
          outcome: "cancel",
        });
        expect(callers).toHaveLength(2);
      } finally {
        admission.close();
      }
    });
  });
});
