import type { AcpPermissionRequest } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { createAcpPermissionHandler } from "./permission-handler.js";

vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const gateway = vi.mocked(callGatewayTool);
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

async function setup() {
  const admission = prepareSystemAgentRunAdmission({}, "permission-run", "coder", "test");
  admissions.push(admission);
  const signal = new AbortController();
  const native = new AbortController();
  let active = true;
  const route = {
    channel: "discord",
    to: "channel:parent",
    accountId: "primary",
    threadId: "topic",
  };
  const handler = createAcpPermissionHandler({
    admittedRunContext: await admission.admit("acp"),
    backendId: "remote-acpx",
    agentId: "coder",
    sessionKey: "agent:coder:acp:child",
    cwd: "/workspace/project",
    signal: signal.signal,
    assertActive: () => {
      if (!active) {
        throw new Error("actor replaced");
      }
    },
    getDeliveryContext: () => route,
  });
  return {
    admission,
    handler,
    signal,
    native,
    route,
    revokeActor: () => {
      active = false;
    },
  };
}

beforeEach(() => {
  gateway.mockReset();
  resetAgentRunRegistryForTest();
});
afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

describe("ACP native permissions", () => {
  it("uses the existing approval transport with the exact child run and current parent route", async () => {
    const { handler, native, route } = await setup();
    route.to = "channel:current-parent";
    const callers: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    gateway.mockImplementation(async (method) => {
      callers.push(getGatewayToolCallerIdentity());
      return method === "plugin.approval.request"
        ? { id: "plugin:request" }
        : { id: "plugin:request", decision: "allow-once", terminalReason: "user" };
    });
    await expect(handler(request(), { signal: native.signal })).resolves.toEqual({
      outcome: "allow_once",
    });
    expect(gateway.mock.calls.map((call) => call[0])).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gateway.mock.calls[0]?.[2]).toMatchObject({
      toolCallId: "native-tool",
      allowedDecisions: ["allow-once", "deny"],
      twoPhase: true,
    });
    expect(callers[0]).toMatchObject({
      agentId: "coder",
      sessionKey: "agent:coder:acp:child",
      approvalOwnerPluginId: "remote-acpx",
      operationalRunInstance: { runId: "permission-run" },
      turnSourceChannel: "discord",
      turnSourceTo: "channel:current-parent",
      turnSourceThreadId: "topic",
    });
    expect(callers[0]?.approvalSignals?.every((signal) => signal.aborted)).toBe(true);
  });

  it.each(["request", "wait"])(
    "does not return a late allow after closure during %s",
    async (stage) => {
      const { handler, native, admission } = await setup();
      const entered = createDeferred();
      const late = createDeferred<unknown>();
      gateway.mockImplementation(async (method) => {
        if ((method === "plugin.approval.request") === (stage === "request")) {
          entered.resolve();
          return late.promise;
        }
        return { id: "plugin:request" };
      });
      const pending = handler(request(), { signal: native.signal });
      await entered.promise;
      admission.close();
      late.resolve({ id: "plugin:request", decision: "allow-once" });
      await expect(pending).resolves.toEqual({ outcome: "cancel" });
    },
  );

  it.each(["native", "turn", "actor"])(
    "fails closed when the %s lifetime ends while waiting",
    async (owner) => {
      const { handler, native, signal, revokeActor } = await setup();
      const entered = createDeferred();
      const late = createDeferred<unknown>();
      gateway.mockResolvedValueOnce({ id: "plugin:request" }).mockImplementationOnce(async () => {
        entered.resolve();
        return late.promise;
      });
      const pending = handler(request(), { signal: native.signal });
      await entered.promise;
      if (owner === "native") {
        native.abort();
      } else if (owner === "turn") {
        signal.abort();
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
    const { handler, native } = await setup();
    gateway.mockResolvedValueOnce({ id: "plugin:request" }).mockResolvedValueOnce(result);
    await expect(handler(request(), { signal: native.signal })).resolves.toEqual({
      outcome: expected,
    });
  });

  it("cancels unavailable transport without falling through to native approve-all", async () => {
    const { handler, native } = await setup();
    gateway.mockRejectedValueOnce(new Error("Gateway disconnected"));
    await expect(handler(request(), { signal: native.signal })).resolves.toEqual({
      outcome: "cancel",
    });
  });

  it("rejects a concurrent duplicate and snapshots a mutable native request", async () => {
    const { handler, native } = await setup();
    const entered = createDeferred();
    const late = createDeferred<unknown>();
    gateway.mockResolvedValueOnce({ id: "plugin:request" }).mockImplementationOnce(async () => {
      entered.resolve();
      return late.promise;
    });
    const mutable = request();
    const first = handler(mutable, { signal: native.signal });
    await entered.promise;
    await expect(handler(request(), { signal: native.signal })).resolves.toEqual({
      outcome: "cancel",
    });
    mutable.raw.options = [];
    late.resolve({ id: "plugin:request", decision: "deny" });
    await expect(first).resolves.toEqual({ outcome: "reject_once" });
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  it("never upgrades a request that only supports permanent permission", async () => {
    const { handler, native } = await setup();
    const permanent = request();
    permanent.raw.options = permanent.raw.options.filter(
      (option) => option.kind === "allow_always",
    );
    await expect(handler(permanent, { signal: native.signal })).resolves.toEqual({
      outcome: "cancel",
    });
    expect(gateway).not.toHaveBeenCalled();
  });
});
