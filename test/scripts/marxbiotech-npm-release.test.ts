import { describe, expect, it } from "vitest";
import {
  releaseIdentity,
  scopedManifest,
  verifyPublishedRelease,
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
