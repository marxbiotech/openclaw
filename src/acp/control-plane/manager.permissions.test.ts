import type { AcpPermissionHandler, AcpPermissionRequest } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";
import type { AcpManagerPermissionHandler } from "./manager.types.js";

const sessionKey = "agent:codex:acp:permission";
const request: AcpPermissionRequest = {
  sessionId: "native",
  inferredKind: "execute",
  raw: {
    sessionId: "native",
    toolCall: { toolCallId: "tool" },
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
  },
};

async function runTurn(
  onNativePermissionRequest: AcpManagerPermissionHandler | undefined,
  inTurn: (relay: AcpPermissionHandler | undefined) => Promise<void>,
) {
  const runtime = createRuntime();
  runtime.ensureSession.mockResolvedValue({
    sessionKey,
    backend: "remote-acpx",
    runtimeSessionName: "runtime",
    cwd: "/workspace/project",
  });
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
    id: "remote-acpx",
    runtime: runtime.runtime,
  });
  hoisted.readAcpSessionEntryMock.mockReturnValue({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: readySessionMeta({ backend: "remote-acpx" }),
  });
  runtime.runTurn.mockImplementationOnce(async function* (input) {
    await inTurn(input.onNativePermissionRequest);
    yield { type: "done", status: "completed" };
  });
  const admission = prepareSystemAgentRunAdmission(baseCfg, "permission-run", "codex", "test");
  try {
    await new AcpSessionManager().runTurn({
      admittedRunContext: await admission.admit("acp"),
      provenance: "agent",
      cfg: baseCfg,
      sessionKey,
      text: "test",
      mode: "prompt",
      requestId: "permission-run",
      onNativePermissionRequest,
    });
  } finally {
    admission.close();
  }
}

describe("ACP manager native permission composition", () => {
  installAcpSessionManagerTestLifecycle();

  it("leaves backends without a relay when ingress supplies none", async () => {
    let relay: AcpPermissionHandler | undefined = () => Promise.resolve(undefined);
    await runTurn(undefined, async (supplied) => {
      relay = supplied;
    });
    expect(relay).toBeUndefined();
  });

  it("adds backend facts and closes the relay when the attempt settles", async () => {
    const seen: Array<Parameters<AcpManagerPermissionHandler>[1]> = [];
    let retained: AcpPermissionHandler | undefined;
    const native = new AbortController();
    await runTurn(
      async (_request, context) => {
        seen.push(context);
        return { outcome: "allow_once" };
      },
      async (relay) => {
        retained = relay;
        await expect(relay!(request, { signal: native.signal })).resolves.toEqual({
          outcome: "allow_once",
        });
      },
    );
    expect(seen[0]).toMatchObject({ backendId: "remote-acpx", cwd: "/workspace/project" });
    expect(seen[0]?.assertActive).toBeTypeOf("function");
    expect(seen[0]?.signal.aborted).toBe(true);
    // A callback retained past its attempt cannot reach a live approval owner.
    await retained!(request, { signal: native.signal });
    expect(seen[1]?.signal.aborted).toBe(true);
  });

  it("cancels when the ingress relay throws instead of selecting backend fallback", async () => {
    await runTurn(
      async () => {
        throw new Error("approval transport failed");
      },
      async (relay) => {
        await expect(relay!(request, { signal: new AbortController().signal })).resolves.toEqual({
          outcome: "cancel",
        });
      },
    );
  });

  it("forwards native abort to the ingress relay", async () => {
    const native = new AbortController();
    const relay = vi.fn<AcpManagerPermissionHandler>(async (_request, context) => {
      native.abort();
      return context.signal.aborted ? { outcome: "cancel" } : { outcome: "allow_once" };
    });
    await runTurn(relay, async (supplied) => {
      await expect(supplied!(request, { signal: native.signal })).resolves.toEqual({
        outcome: "cancel",
      });
    });
    expect(relay).toHaveBeenCalledOnce();
  });
});
