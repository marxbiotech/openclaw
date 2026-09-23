import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  runGlobalPackageUpdateSteps,
  type PackageUpdateTransaction,
} from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveGlobalInstallTarget } from "./update-global.js";

const registryName = "@marxbiotech/openclaw";

async function writeFork(root: string, version: string): Promise<void> {
  await writePackageRoot(root, version);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: registryName, version }),
  );
  await fs.writeFile(path.join(root, "openclaw.mjs"), `console.log(${JSON.stringify(version)});\n`);
}

describe("scoped package installed under the openclaw alias", () => {
  it.runIf(process.platform !== "win32").each(["2.0.0", "2.0.1"])(
    "retains a runnable npm launcher and exact candidate verification (%s)",
    async (candidateVersion) => {
      await withTestDir({ prefix: "openclaw-update-fork-alias-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const launcher = path.join(prefix, "bin", "openclaw");
        await writeFork(packageRoot, "1.0.0");
        await fs.mkdir(path.dirname(launcher), { recursive: true });
        await fs.symlink("../lib/node_modules/openclaw/openclaw.mjs", launcher);
        let transaction: PackageUpdateTransaction | undefined;
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: `${registryName}@2.0.0`,
          packageName: registryName,
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          onTransaction: (value) => {
            transaction = value;
          },
          runStep: async ({ name, argv, cwd }) => {
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            // Model npm's dependency-key layout and real relative executable link.
            const aliasSpec = `openclaw@npm:${registryName}@2.0.0`;
            const installName = argv.includes(aliasSpec) ? "openclaw" : registryName;
            const candidate = path.join(stagePrefix, "lib", "node_modules", installName);
            await writeFork(candidate, candidateVersion);
            const stagedLauncher = path.join(stagePrefix, "bin", "openclaw");
            await fs.mkdir(path.dirname(stagedLauncher), { recursive: true });
            await fs.symlink(
              path.relative(path.dirname(stagedLauncher), path.join(candidate, "openclaw.mjs")),
              stagedLauncher,
            );
            return { name, command: argv.join(" "), cwd: cwd ?? base, durationMs: 0, exitCode: 0 };
          },
          timeoutMs: 1000,
        });
        if (candidateVersion !== "2.0.0") {
          expect(result.failedStep?.name).toBe("global install verify");
          expect(execFileSync(process.execPath, [launcher], { encoding: "utf8" })).toBe("1.0.0\n");
          expect(transaction).toBeUndefined();
          return;
        }
        expect(result.failedStep, JSON.stringify(result.steps)).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        expect(execFileSync(process.execPath, [launcher], { encoding: "utf8" })).toBe("2.0.0\n");
        expect(await fs.realpath(launcher)).toBe(path.join(packageRoot, "openclaw.mjs"));
        expect(result.steps[0]?.command).toContain(`openclaw@npm:${registryName}@2.0.0`);
        if (!transaction) {
          throw new Error("missing retained update transaction");
        }
        expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 0 });
        expect(execFileSync(process.execPath, [launcher], { encoding: "utf8" })).toBe("1.0.0\n");
      });
    },
  );

  it.each(["./candidate.tgz", "file:./candidate", "github:example/openclaw#main"])(
    "leaves the alias runtime unchanged when its target cannot preserve npm alias layout: %s",
    async (installSpec) => {
      await withTestDir({ prefix: "openclaw-update-fork-alias-source-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writeFork(packageRoot, "1.0.0");
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec,
          packageName: registryName,
          runCommand: async () => {
            throw new Error("alias preflight must not invoke npm");
          },
          runStep: async () => {
            throw new Error("alias preflight must not mutate");
          },
          timeoutMs: 1000,
        });
        expect(result.failedStep).toMatchObject({
          name: "package alias preflight",
          stderrTail: expect.stringContaining("cannot preserve the existing launcher layout"),
        });
        expect(result.recovery).toMatchObject({ serviceRestartSafe: true, version: "1.0.0" });
        expect(
          JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")),
        ).toMatchObject({
          name: registryName,
          version: "1.0.0",
        });
      });
    },
  );

  it("preserves pnpm isolated ownership and refuses shared alias projects before mutation", async () => {
    await withTestDir({ prefix: "openclaw-update-fork-pnpm-alias-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const projectRoot = path.join(globalRoot, "a1b2");
      const packageRoot = path.join(projectRoot, "node_modules", "openclaw");
      await writeFork(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: { openclaw: `npm:${registryName}@1.0.0`, cowsay: "1.6.0" },
        }),
      );
      await fs.writeFile(path.join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await fs.symlink(projectRoot, path.join(globalRoot, "hash-a1b2"), "dir");
      const runCommand = async (argv: string[]) => {
        if (argv.join(" ") !== "pnpm root -g") {
          throw new Error(`unexpected command ${argv.join(" ")}`);
        }
        return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
      };
      const installTarget = await resolveGlobalInstallTarget({
        manager: "pnpm",
        packageName: registryName,
        pkgRoot: packageRoot,
        honorPackageRoot: true,
        runCommand,
        timeoutMs: 1000,
      });
      expect(installTarget).toMatchObject({
        packageRoot,
        globalRoot,
        pnpmIsolated: { layoutVersion: 11 },
      });
      const result = await runGlobalPackageUpdateSteps({
        installTarget,
        installSpec: `${registryName}@2.0.0`,
        packageName: registryName,
        runCommand,
        timeoutMs: 1000,
        runStep: async () => {
          throw new Error("shared pnpm project must not mutate");
        },
      });
      expect(result.failedStep).toMatchObject({
        name: "pnpm isolated install preflight",
        stderrTail: expect.stringContaining("shares a pnpm 11 global install group with cowsay"),
      });
    });
  });
});
