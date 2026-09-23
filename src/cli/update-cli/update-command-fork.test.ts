import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import * as shared from "./shared.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { updateCommand } from "./update-command.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
vi.mock("./update-command-plugin-preflight.js", () => ({
  preflightConfiguredNpmPluginTargets: async () => [],
}));
const { fixture } = installFreshUpdateFixture();

it.each([undefined, "2026.9.5"])(
  "keeps the installed fork through update admission (tag %s)",
  async (tag) => {
    fs.writeFileSync(
      path.join(fixture.root, "package.json"),
      JSON.stringify({ name: "@marxbiotech/openclaw", version: "2026.9.4" }),
    );
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue("2026.9.5");
    vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2026.9.5",
    });
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      target: "2026.9.5",
      version: "2026.9.5",
    });

    await updateCommand({
      channel: "stable",
      tag,
      dryRun: true,
      json: true,
      yes: true,
      restart: false,
    });

    if (tag) {
      expect(shared.resolveTargetVersion).toHaveBeenCalledWith(
        tag,
        expect.any(Number),
        expect.objectContaining({
          packageName: "@marxbiotech/openclaw",
          spec: "@marxbiotech/openclaw@2026.9.5",
        }),
      );
    } else {
      expect(updateCheck.resolveNpmChannelTag).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "@marxbiotech/openclaw" }),
      );
    }
    expect(packageMetadata.fetchNpmPackageTargetStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@marxbiotech/openclaw",
        spec: "@marxbiotech/openclaw@2026.9.5",
      }),
    );
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        targetVersion: "2026.9.5",
        actions: expect.arrayContaining([
          "Run global package manager update with spec @marxbiotech/openclaw@2026.9.5",
        ]),
      }),
    );
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  },
);
