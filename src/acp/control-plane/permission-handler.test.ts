import type { AcpPermissionRequest } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { readAcpSpawnParentDeliveryContext } from "../../agents/subagents/spawn/acp-spawn-requester.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { createAcpPermissionHandler } from "./permission-handler.js";

vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
vi.mock("../../agents/subagents/spawn/acp-spawn-requester.js", () => ({
  readAcpSpawnParentDeliveryContext: vi.fn(),
}));

const gateway = vi.mocked(callGatewayTool);
const parentRoute = vi.mocked(readAcpSpawnParentDeliveryContext);
const admissions: PreparedAgentRunAdmission[] = [];

function request(): AcpPermissionRequest {
  return {
    sessionId: "native-session",
    inferredKind: "execute",
    raw: {
      sessionId: "native-session",
      toolCall: {
        toolCallId: "native-tool",
        title: "Run tests",
        rawInput: { command: "pnpm test" },
      },
      options: [
        { kind: "allow_once", optionId: "once", name: "Allow once" },
        { kind: "allow_always", optionId: "always", name: "Always allow" },
        { kind: "reject_once", optionId: "deny", name: "Deny" },
      ],
    },
  };
}

async function setup(route: Parameters<typeof createAcpPermissionHandler>[0]["route"] = {}) {
  const admission = prepareSystemAgentRunAdmission({}, "permission-run", "coder", "test");
  admissions.push(admission);
  const turn = new AbortController();
  const native = new AbortController();
  let active = true;
  const handler = createAcpPermissionHandler({
    admittedRunContext: await admission.admit("acp"),
    agentId: "coder",
    sessionKey: "agent:coder:acp:child",
    route,
  });
  const context = () => ({
    signal: AbortSignal.any([native.signal, turn.signal]),
    backendId: "remote-acpx",
    cwd: "/workspace/project",
    assertActive: () => {
      if (!active) {
        throw new Error("actor replaced");
      }
    },
  });
  return {
    admission,
    handler,
    turn,
    native,
    context,
    revokeActor: () => {
      active = false;
    },
  };
}

beforeEach(() => {
  gateway.mockReset();
  parentRoute.mockReset();
  resetAgentRunRegistryForTest();
});
afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

describe("ACP native permissions", () => {
  it("asks in the spawning parent's current conversation as the exact child run", async () => {
    parentRoute.mockResolvedValue({
      channel: "discord",
      to: "channel:current-parent",
      accountId: "primary",
      threadId: "topic",
    });
    const { handler, context } = await setup({
      parentSessionKey: "agent:main:discord:channel:parent",
      fallback: { channel: "slack", to: "channel:ignored" },
    });
    const callers: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    gateway.mockImplementation(async (method) => {
      callers.push(getGatewayToolCallerIdentity());
      return method === "plugin.approval.request"
        ? { id: "plugin:request" }
        : { id: "plugin:request", decision: "allow-once", terminalReason: "user" };
    });
    const ctx = context();
    await expect(handler(request(), ctx)).resolves.toEqual({ outcome: "allow_once" });
    expect(parentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:discord:channel:parent",
        requesterAgentId: "coder",
      }),
    );
    expect(gateway.mock.calls.map((call) => call[0])).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gateway.mock.calls[0]?.[2]).toMatchObject({
      toolName: "acp.execute",
      toolCallId: "native-tool",
      allowedDecisions: ["allow-once", "deny"],
      twoPhase: true,
    });
    expect(gateway.mock.calls[0]?.[2]).toMatchObject({
      description: expect.stringContaining("Working directory: /workspace/project"),
    });
    expect(callers[0]).toMatchObject({
      agentId: "coder",
      sessionKey: "agent:coder:acp:child",
      approvalOwnerPluginId: "remote-acpx",
      operationalRunInstance: { runId: "permission-run" },
      turnSourceChannel: "discord",
      turnSourceTo: "channel:current-parent",
      turnSourceAccountId: "primary",
      turnSourceThreadId: "topic",
    });
    expect(callers[0]?.approvalSignals?.every((signal) => signal.aborted)).toBe(true);
  });

  it("asks in the turn's own conversation when it was not spawned", async () => {
    const { handler, context } = await setup({
      fallback: { channel: "slack", to: "channel:C1", threadId: "171.5" },
    });
    const callers: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    gateway.mockImplementation(async (method) => {
      callers.push(getGatewayToolCallerIdentity());
      return method === "plugin.approval.request"
        ? { id: "plugin:request" }
        : { id: "plugin:request", decision: "deny" };
    });
    await expect(handler(request(), context())).resolves.toEqual({ outcome: "reject_once" });
    expect(parentRoute).not.toHaveBeenCalled();
    expect(callers[0]).toMatchObject({
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C1",
      turnSourceThreadId: "171.5",
    });
  });

  it("cancels without asking when the parent route cannot be read", async () => {
    parentRoute.mockRejectedValue(new Error("parent session unavailable"));
    const { handler, context } = await setup({ parentSessionKey: "agent:main:main" });
    await expect(handler(request(), context())).resolves.toEqual({ outcome: "cancel" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(["request", "wait"])(
    "does not return a late allow after closure during %s",
    async (stage) => {
      const { handler, context, admission } = await setup();
      const entered = createDeferred();
      const late = createDeferred<unknown>();
      gateway.mockImplementation(async (method) => {
        if ((method === "plugin.approval.request") === (stage === "request")) {
          entered.resolve();
          return late.promise;
        }
        return { id: "plugin:request" };
      });
      const pending = handler(request(), context());
      await entered.promise;
      admission.close();
      late.resolve({ id: "plugin:request", decision: "allow-once" });
      await expect(pending).resolves.toEqual({ outcome: "cancel" });
    },
  );

  it.each(["native", "turn", "actor"])(
    "fails closed when the %s lifetime ends while waiting",
    async (owner) => {
      const { handler, native, turn, context, revokeActor } = await setup();
      const entered = createDeferred();
      const late = createDeferred<unknown>();
      gateway.mockResolvedValueOnce({ id: "plugin:request" }).mockImplementationOnce(async () => {
        entered.resolve();
        return late.promise;
      });
      const pending = handler(request(), context());
      await entered.promise;
      if (owner === "native") {
        native.abort();
      } else if (owner === "turn") {
        turn.abort();
      } else {
        revokeActor();
      }
      late.resolve({ id: "plugin:request", decision: "allow-once" });
      await expect(pending).resolves.toEqual({ outcome: "cancel" });
    },
  );

  it.each([
    {
      result: { id: "plugin:request", decision: "deny", terminalReason: "user" },
      expected: "reject_once",
    },
    {
      result: { id: "plugin:request", decision: null, terminalReason: "timeout" },
      expected: "cancel",
    },
    { result: { id: "other", decision: "allow-once" }, expected: "cancel" },
    { result: { id: "plugin:request", decision: "allow-always" }, expected: "cancel" },
  ])("maps only supported one-shot verdicts: $expected", async ({ result, expected }) => {
    const { handler, context } = await setup();
    gateway.mockResolvedValueOnce({ id: "plugin:request" }).mockResolvedValueOnce(result);
    await expect(handler(request(), context())).resolves.toEqual({ outcome: expected });
  });

  it("cancels unavailable transport without falling through to native approve-all", async () => {
    const { handler, context } = await setup();
    gateway.mockRejectedValueOnce(new Error("Gateway disconnected"));
    await expect(handler(request(), context())).resolves.toEqual({ outcome: "cancel" });
  });

  it("rejects a concurrent duplicate and snapshots a mutable native request", async () => {
    const { handler, context } = await setup();
    const entered = createDeferred();
    const late = createDeferred<unknown>();
    gateway.mockResolvedValueOnce({ id: "plugin:request" }).mockImplementationOnce(async () => {
      entered.resolve();
      return late.promise;
    });
    const mutable = request();
    const first = handler(mutable, context());
    await entered.promise;
    await expect(handler(request(), context())).resolves.toEqual({ outcome: "cancel" });
    mutable.raw.options = [];
    late.resolve({ id: "plugin:request", decision: "deny" });
    await expect(first).resolves.toEqual({ outcome: "reject_once" });
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  it("never upgrades a request that only supports permanent permission", async () => {
    const { handler, context } = await setup();
    const permanent = request();
    permanent.raw.options = permanent.raw.options.filter(
      (option) => option.kind === "allow_always",
    );
    await expect(handler(permanent, context())).resolves.toEqual({ outcome: "cancel" });
    expect(gateway).not.toHaveBeenCalled();
  });
});
