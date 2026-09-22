import fs from "node:fs";
import type { AcpRuntime as CoreAcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import {
  privateLocalOnlyPluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "../../scripts/lib/plugin-sdk-entries.mjs";
import {
  getAcpRuntimeBackend as getCoreBackend,
  registerAcpRuntimeBackend as registerCoreBackend,
  unregisterAcpRuntimeBackend as unregisterCoreBackend,
} from "../acp/runtime/registry.js";
import type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
} from "../plugins/types.js";

const { managerLoaded, dispatchLoaded, dispatch } = vi.hoisted(() => ({
  managerLoaded: vi.fn(),
  dispatchLoaded: vi.fn(),
  dispatch: vi.fn(async () => ({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } })),
}));

vi.mock("../acp/control-plane/manager.js", () => {
  managerLoaded();
  throw new Error("Backend registration must not load the ACP control plane");
});
vi.mock("../auto-reply/reply/dispatch-acp.runtime.js", () => {
  dispatchLoaded();
  return {
    shouldBypassAcpDispatchForCommand: async () => false,
    tryDispatchAcpReply: dispatch,
  };
});

import * as backend from "openclaw/plugin-sdk/acp-backend";
import type { AcpRuntime, AcpRuntimeEnsureInput } from "openclaw/plugin-sdk/acp-backend";

const backendId = "sdk-backend-contract-test";
afterEach(() => unregisterCoreBackend(backendId));

it("registers public plugin backends in the same registry consumed by core", () => {
  const runtime: AcpRuntime = {
    ownerAwareSessions: 1,
    async ensureSession(input) {
      return {
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        backend: backendId,
        runtimeSessionName: "fixture",
      };
    },
    async *runTurn() {},
    async cancel() {},
    async close() {},
  };
  backend.registerAcpRuntimeBackend({ id: backendId, runtime });
  expect(getCoreBackend(backendId)?.runtime).toBe(runtime);
  unregisterCoreBackend(backendId);
  expect(backend.getAcpRuntimeBackend(backendId)).toBeNull();
  registerCoreBackend({ id: backendId, runtime });
  expect(backend.getAcpRuntimeBackend(backendId)?.runtime).toBe(runtime);
  backend.unregisterAcpRuntimeBackend(backendId);
  expect(getCoreBackend(backendId)).toBeNull();
  expect(managerLoaded).not.toHaveBeenCalled();
  expect(dispatchLoaded).not.toHaveBeenCalled();
});

it("publishes canonical typed backend contracts without exposing manager ownership", () => {
  expectTypeOf<AcpRuntime>().toEqualTypeOf<CoreAcpRuntime>();
  expectTypeOf<AcpRuntimeEnsureInput>().toEqualTypeOf<
    Parameters<CoreAcpRuntime["ensureSession"]>[0]
  >();
  expectTypeOf<typeof backend>().not.toHaveProperty("getAcpSessionManager");
  expect(backend).not.toHaveProperty("getAcpSessionManager");
  expect(backend).not.toHaveProperty("testing");
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  expect(packageJson.exports["./plugin-sdk/acp-backend"]).toEqual({
    types: "./dist/plugin-sdk/acp-backend.d.ts",
    default: "./dist/plugin-sdk/acp-backend.js",
  });
  expect(publicPluginSdkEntrypoints).toContain("acp-backend");
  expect(privateLocalOnlyPluginSdkEntrypoints).not.toContain("acp-backend");
});

it("loads dispatch only when an eligible reply calls the public hook", async () => {
  const event: PluginHookReplyDispatchEvent = {
    ctx: {
      Body: "fixture",
      BodyForAgent: "fixture",
      BodyForCommands: "fixture",
      SessionKey: "agent:fixture:acp:test",
      CommandAuthorized: false,
    },
    runId: "fixture-run",
    sessionKey: "agent:fixture:acp:test",
    inboundAudio: false,
    shouldRouteToOriginating: false,
    shouldSendToolSummaries: false,
    shouldSendFullToolDetails: false,
    sendPolicy: "deny",
  };
  const context: PluginHookReplyDispatchContext = {
    cfg: {},
    dispatcher: {
      sendToolResult: () => false,
      sendBlockReply: () => false,
      sendFinalReply: () => false,
      waitForIdle: async () => {},
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {},
    },
    recordProcessed: () => {},
    markIdle: () => {},
  };
  await expect(backend.tryDispatchAcpReplyHook(event, context)).resolves.toBeUndefined();
  expect(dispatchLoaded).not.toHaveBeenCalled();
  await expect(
    backend.tryDispatchAcpReplyHook({ ...event, sendPolicy: "allow" }, context),
  ).resolves.toEqual({
    handled: true,
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  });
  expect(dispatchLoaded).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(managerLoaded).not.toHaveBeenCalled();
});
