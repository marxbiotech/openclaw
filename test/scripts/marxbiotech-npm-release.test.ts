import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  releaseIdentity,
  scopedManifest,
  verifyPublishedRelease,
  waitForPublishedRelease,
} from "../../scripts/marxbiotech-npm-release.mjs";

describe("fork npm release artifact", () => {
  it.each([
    ["mb2026.9.5", "2026.9.5", "latest"],
    ["mb2026.9.5-beta.6", "2026.9.5-beta.6", "beta"],
    ["mb2026.9.5-alpha.1", "2026.9.5-alpha.1", "alpha"],
    ["mb2026.9.5-rc.1", "2026.9.5-rc.1", "beta"],
  ])("maps %s to an exact scoped version and channel", (tag, version, npmTag) => {
    expect(releaseIdentity(tag, "2026.9.5")).toMatchObject({
      packageName: "@marxbiotech/openclaw",
      version,
      npmTag,
    });
  });

  it.each(["v2026.9.5", "mb2026.9.6", "mb2026.9.5/escape", "mb2026.9.5-beta.01", "mbjunk"])(
    "refuses malformed or mismatched immutable tags: %s",
    (tag) => expect(() => releaseIdentity(tag, "2026.9.5")).toThrow(),
  );

  it.each(["mb2026.9.5-0", "mb2026.9.5-0a.01b.0-1", "mb2026.9.5--.--"])(
    "retains valid semantic prerelease identifiers: %s",
    (tag) => {
      expect(releaseIdentity(tag, "2026.9.5").version).toBe(tag.slice(2));
    },
  );

  it.each(["mb2026.9.5-", "mb2026.9.5-beta..1", "mb2026.9.5-00", "mb2026.9.5-1.01"])(
    "rejects empty or zero-padded numeric prerelease identifiers: %s",
    (tag) => expect(() => releaseIdentity(tag, "2026.9.5")).toThrow(),
  );

  it("handles long repeated hyphen identifiers without regex backtracking", () => {
    const scriptUrl = new URL("../../scripts/marxbiotech-npm-release.mjs", import.meta.url).href;
    // A process deadline bounds this regression even if an unsafe synchronous regex returns.
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { releaseIdentity } from ${JSON.stringify(scriptUrl)};
          const identifiers = "--.".repeat(20_000);
          assert.throws(() => releaseIdentity("mb2026.9.5-" + identifiers + "!", "2026.9.5"));
          const valid = "mb2026.9.5-" + identifiers + "end";
          assert.equal(releaseIdentity(valid, "2026.9.5").version, valid.slice(2));
        `,
      ],
      { timeout: 2_000, stdio: "pipe" },
    );
  });

  it("retains CLI, public SDK, workspace bundle, lifecycle and executable permissions", () => {
    const original = {
      name: "openclaw",
      version: "2026.9.5",
      bin: { openclaw: "openclaw.mjs" },
      exports: { "./plugin-sdk/acp-backend": "./dist/plugin-sdk/acp-backend.js" },
      dependencies: { "@openclaw/ai": "2026.9.5" },
      bundledDependencies: ["@openclaw/ai"],
      scripts: { postinstall: "node dist/postinstall.js" },
      publishConfig: { executableFiles: ["dist/entry.js"] },
    };
    const result = scopedManifest(original, releaseIdentity("mb2026.9.5", "2026.9.5"));
    expect(result.name).toBe("@marxbiotech/openclaw");
    expect(result.repository.url).toBe("git+https://github.com/marxbiotech/openclaw.git");
    expect(result.publishConfig).toEqual({
      executableFiles: ["dist/entry.js"],
      access: "public",
      registry: "https://registry.npmjs.org",
    });
    for (const field of [
      "bin",
      "exports",
      "dependencies",
      "bundledDependencies",
      "scripts",
    ] as const) {
      expect(result[field]).toEqual(original[field]);
    }
    expect(original.name).toBe("openclaw");
  });

  it("reconciles an existing immutable version only when registry bytes match", () => {
    const release = { version: "2026.9.5", integrity: "sha512-exact" };
    const published = {
      name: "@marxbiotech/openclaw",
      version: release.version,
      dist: { integrity: release.integrity },
    };
    expect(() => verifyPublishedRelease(published, release)).not.toThrow();
    expect(() => verifyPublishedRelease({ ...published, name: "openclaw" }, release)).toThrow();
    expect(() =>
      verifyPublishedRelease({ ...published, dist: { integrity: "sha512-other" } }, release),
    ).toThrow();
  });
});

describe("fork npm publication visibility", () => {
  const release = { version: "2026.9.5", npmTag: "latest", integrity: "sha512-exact" };
  const published = {
    name: "@marxbiotech/openclaw",
    version: release.version,
    dist: { integrity: release.integrity },
  };
  const visible = { body: published };
  const missing = { status: 404 };

  function registryFixture(
    replies: Array<{ status?: number; body?: unknown; elapsedMs?: number }>,
  ) {
    let elapsed = 0;
    const pending = [...replies];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const reply = pending.shift();
      if (!reply) {
        throw new Error("unexpected registry request");
      }
      elapsed += reply.elapsedMs ?? 0;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
    });
    const sleep = vi.fn(async (milliseconds: number) => {
      elapsed += milliseconds;
    });
    const log = vi.fn();
    return {
      fetchImpl,
      sleep,
      log,
      options: { fetchImpl, sleep, log, now: () => elapsed },
    };
  }

  it("waits through the accepted upload scan and delayed selector propagation", async () => {
    const fixture = registryFixture([
      missing,
      missing,
      visible,
      missing,
      visible,
      { body: { ...published, version: "2026.3.11" } },
      visible,
      visible,
    ]);
    await expect(waitForPublishedRelease(release, fixture.options)).resolves.toEqual(published);
    expect(
      fixture.fetchImpl.mock.calls.map(([url]) =>
        (url instanceof Request ? url.url : url.toString()).split("/").at(-1),
      ),
    ).toEqual([
      "2026.9.5",
      "2026.9.5",
      "2026.9.5",
      "latest",
      "2026.9.5",
      "latest",
      "2026.9.5",
      "latest",
    ]);
    expect(fixture.sleep.mock.calls).toEqual([[15_000], [15_000], [15_000], [15_000]]);
    expect(fixture.log.mock.calls[0]?.[0]).toContain("npm is still processing");
    expect(fixture.log.mock.calls.at(-1)?.[0]).toContain("dist-tag latest");
  });

  it("finishes immediately when a rerun sees the exact published artifact and selector", async () => {
    const fixture = registryFixture([visible, visible]);
    await expect(waitForPublishedRelease(release, fixture.options)).resolves.toEqual(published);
    expect(fixture.sleep).not.toHaveBeenCalled();
    expect(fixture.log).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["version", "selector"])(
    "rejects conflicting %s integrity without waiting or writing",
    async (location) => {
      const conflicting = { body: { ...published, dist: { integrity: "sha512-other" } } };
      const fixture = registryFixture(
        location === "version" ? [conflicting] : [visible, conflicting],
      );
      await expect(waitForPublishedRelease(release, fixture.options)).rejects.toThrow(
        "Published version has different bytes",
      );
      expect(fixture.sleep).not.toHaveBeenCalled();
      expect(fixture.log).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 500])("does not treat HTTP %s as publication processing", async (status) => {
    const fixture = registryFixture([{ status }]);
    await expect(waitForPublishedRelease(release, fixture.options)).rejects.toThrow(
      `Registry read failed: HTTP ${status}`,
    );
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it.each(["version", "selector"])(
    "bounds waiting for a missing %s and warns against blind publication retries",
    async (location) => {
      const fixture = registryFixture(
        location === "version"
          ? [missing, missing, missing]
          : [visible, missing, visible, missing, visible, missing],
      );
      await expect(
        waitForPublishedRelease(release, { ...fixture.options, timeoutMs: 35_000 }),
      ).rejects.toThrow(
        /npm accepted .*not visible after 35s.*Publication was not retried.*maintainer scan status.*never rerun blindly/,
      );
      expect(fixture.sleep.mock.calls).toEqual([[15_000], [15_000], [5_000]]);
      expect(fixture.options.now()).toBe(35_000);
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(location === "version" ? 3 : 6);
    },
  );

  it("counts registry request time against the total visibility budget", async () => {
    const fixture = registryFixture([{ ...visible, elapsedMs: 35_000 }]);
    await expect(
      waitForPublishedRelease(release, { ...fixture.options, timeoutMs: 35_000 }),
    ).rejects.toThrow("dist-tag latest is not visible after 35s");
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fixture.sleep).not.toHaveBeenCalled();
  });
});
