import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { saveExecApprovals, type ExecAsk, type ExecSecurity } from "../infra/exec-approvals.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { invokeRegisteredNodeHostCommand } from "./plugin-node-host.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "node-plugin-exec-policy-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot({});
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const authorizationSources = ["session-full", "human-approved", "configured-policy"] as const;

function launch(
  source: (typeof authorizationSources)[number],
  whilePreparing: () => void = () => {},
) {
  const spawn = vi.fn();
  const controller = new AbortController();
  const registry = createEmptyPluginRegistry();
  let retainedPrepare: (() => () => void) | undefined;
  let retainedGuard: (() => void) | undefined;
  registry.plugins.push(
    createPluginRecord({
      id: "fixture",
      source: "fixture",
      origin: "bundled",
      enabled: true,
      configSchema: true,
    }),
  );
  registry.nodeHostCommands.push({
    pluginId: "fixture",
    pluginName: "Fixture",
    source: "fixture",
    command: {
      command: "fixture.exec",
      dangerous: true,
      handle: async (_params, _io, context) => {
        const prepare =
          source === "configured-policy"
            ? context!.prepareConfiguredExecAuthorization!
            : () => context!.prepareExecAuthorization!(source);
        retainedPrepare = prepare;
        const assertAuthorized = prepare();
        retainedGuard = assertAuthorized;
        await Promise.resolve();
        whilePreparing();
        assertAuthorized();
        spawn();
        return "{}";
      },
    },
  });
  setActivePluginRegistry(registry);
  const result = invokeRegisteredNodeHostCommand("fixture.exec", "{}", undefined, {
    sendNodeEvent: async () => undefined,
    sessionKey: "agent:main:session",
    signal: controller.signal,
  });
  return {
    result,
    spawn,
    controller,
    registry,
    getRetainedAuthorization: () => ({ prepare: retainedPrepare, guard: retainedGuard }),
  };
}

function setPolicy(owner: "config" | "approvals", security: ExecSecurity, ask: ExecAsk) {
  if (owner === "config") {
    setRuntimeConfigSnapshot({ tools: { exec: { security, ask } } });
  } else {
    saveExecApprovals({ version: 1, defaults: { security, ask } });
  }
}

describe("plugin node execution authorization", () => {
  it.each(["config", "approvals"] as const)(
    "keeps %s restrictions for Full, configured policy, and explicit human decisions",
    async (owner) => {
      for (const security of ["full", "allowlist", "deny"] as const) {
        for (const ask of ["off", "on-miss", "always"] as const) {
          for (const source of authorizationSources) {
            setPolicy(owner, security, ask);
            const { result, spawn } = launch(source);
            const allowed =
              source === "human-approved"
                ? security !== "deny"
                : security === "full" && ask === "off";
            if (allowed) {
              await expect(result).resolves.toBe("{}");
              expect(spawn).toHaveBeenCalledOnce();
            } else {
              await expect(result).rejects.toThrow();
              expect(spawn).not.toHaveBeenCalled();
            }
          }
        }
      }
    },
  );

  it.each(["config", "approvals"] as const)(
    "refuses %s tightening during awaited setup",
    async (owner) => {
      for (const source of authorizationSources) {
        for (const [security, ask] of [
          ["deny", "off"],
          ["allowlist", "off"],
          ["full", "always"],
        ] as const) {
          setPolicy(owner, "full", "off");
          const { result, spawn } = launch(source, () => setPolicy(owner, security, ask));
          await expect(result).rejects.toThrow();
          expect(spawn).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(["cancel", "plugin-replaced", "plugin-disabled", "command-replaced"] as const)(
    "refuses %s during awaited setup",
    async (reason) => {
      for (const source of authorizationSources) {
        const invocation = launch(source, () => {
          if (reason === "cancel") {
            invocation.controller.abort();
          } else if (reason === "plugin-replaced") {
            setActivePluginRegistry(createEmptyPluginRegistry());
          } else if (reason === "plugin-disabled") {
            const plugin = invocation.registry.plugins[0];
            if (!plugin) {
              throw new Error("Expected the registered fixture plugin");
            }
            plugin.enabled = false;
          } else {
            const registration = invocation.registry.nodeHostCommands[0];
            if (!registration) {
              throw new Error("Expected the registered fixture command");
            }
            registration.command = { ...registration.command };
          }
        });
        await expect(invocation.result).rejects.toThrow("authority is closed");
        expect(invocation.spawn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["config", "approvals"] as const)(
    "respects the invocation agent's %s policy over permissive global defaults",
    async (owner) => {
      if (owner === "config") {
        setRuntimeConfigSnapshot({
          tools: { exec: { security: "full", ask: "off" } },
          agents: { list: [{ id: "main", tools: { exec: { security: "deny" } } }] },
        });
      } else {
        saveExecApprovals({
          version: 1,
          defaults: { security: "full", ask: "off" },
          agents: { main: { security: "deny" } },
        });
      }
      const invocation = launch("configured-policy");
      await expect(invocation.result).rejects.toThrow();
      expect(invocation.spawn).not.toHaveBeenCalled();
    },
  );

  it("closes retained configured-policy preparers and guards when the invocation settles", async () => {
    const invocation = launch("configured-policy");
    await expect(invocation.result).resolves.toBe("{}");
    expect(invocation.spawn).toHaveBeenCalledOnce();
    const retained = invocation.getRetainedAuthorization();
    expect(retained.prepare).toThrow("authority is closed");
    expect(retained.guard).toThrow("authority is closed");
  });
});
