#!/usr/bin/env node
// Fork npm publication adapts the canonical artifact; core and plugin SDK keep their CLI identity.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@marxbiotech/openclaw";
const REGISTRY = "https://registry.npmjs.org";
const REPOSITORY = "https://github.com/marxbiotech/openclaw";
const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
const writeJson = (filename, value) =>
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
const capture = (command, args, options = {}) =>
  run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
const integrity = (filename) =>
  `sha512-${createHash("sha512").update(fs.readFileSync(filename)).digest("base64")}`;

export function releaseIdentity(tag, sourceVersion) {
  const match =
    /^mb((\d{4}\.[1-9]\d*\.(?:0|[1-9]\d*))(?:-((?:0|[1-9]\d*|[\da-z-]*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|[\da-z-]*[a-z-][\da-z-]*))*))?)$/iu.exec(
      tag ?? "",
    );
  if (!match) {
    throw new Error(
      "Expected an mb-prefixed semantic release tag, e.g. mb2026.9.5 or mb2026.9.5-beta.1",
    );
  }
  const [, version, base, prerelease] = match;
  if (sourceVersion !== base && sourceVersion !== version) {
    throw new Error(`Tag ${tag} does not match source package version ${sourceVersion}`);
  }
  return {
    tag,
    packageName: PACKAGE,
    version,
    sourceVersion,
    npmTag: prerelease ? (prerelease.startsWith("alpha.") ? "alpha" : "beta") : "latest",
  };
}

export function scopedManifest(manifest, release) {
  assert.equal(manifest.name, "openclaw");
  assert.equal(manifest.version, release.version);
  assert.equal(manifest.bin?.openclaw, "openclaw.mjs");
  return {
    ...manifest,
    name: PACKAGE,
    private: false,
    repository: { type: "git", url: `git+${REPOSITORY}.git` },
    homepage: `${REPOSITORY}#readme`,
    bugs: { url: `${REPOSITORY}/issues` },
    publishConfig: { ...manifest.publishConfig, access: "public", registry: REGISTRY },
  };
}

function releaseBundle(directory) {
  const release = readJson(path.join(directory, "release.json"));
  const identity = releaseIdentity(release.tag, release.sourceVersion);
  for (const [key, value] of Object.entries(identity)) {
    assert.equal(release[key], value, `Release identity mismatch: ${key}`);
  }
  assert.match(release.commit, /^[a-f0-9]{40}$/u);
  assert.equal(release.tarball, `marxbiotech-openclaw-${release.version}.tgz`);
  const tarball = path.join(directory, release.tarball);
  assert.equal(integrity(tarball), release.integrity, "Release tarball integrity mismatch");
  return { release, tarball };
}

async function pack(tag, directory) {
  const manifestPath = path.join(ROOT, "package.json");
  const original = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  const identity = releaseIdentity(tag, manifest.version);
  const commit = capture("git", ["rev-parse", "HEAD"]);
  fs.mkdirSync(directory, { recursive: true });
  assert(
    !fs.existsSync(path.join(directory, "release.json")),
    "Choose a fresh release output directory",
  );
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "marxbiotech-npm-pack-"));
  try {
    // The normal build owner stamps the release version throughout runtime/UI and inventory.
    if (manifest.version !== identity.version) {
      writeJson(manifestPath, { ...manifest, version: identity.version });
    }
    run(
      process.execPath,
      [
        "scripts/package-openclaw-for-docker.mjs",
        "--allow-unreleased-changelog",
        "--output-dir",
        temporary,
        "--output-name",
        "openclaw-canonical.tgz",
      ],
      { env: { ...process.env, GIT_COMMIT: commit } },
    );
    const stage = path.join(temporary, "stage");
    fs.mkdirSync(stage);
    run("tar", ["-xzf", path.join(temporary, "openclaw-canonical.tgz"), "-C", stage]);
    const packageRoot = path.join(stage, "package");
    const packageJsonPath = path.join(packageRoot, "package.json");
    writeJson(packageJsonPath, scopedManifest(readJson(packageJsonPath), identity));
    const readme = path.join(packageRoot, "README.md");
    fs.writeFileSync(
      readme,
      `# Marxbiotech OpenClaw distribution

Published as \`@marxbiotech/openclaw\`; the CLI remains \`openclaw\`.

\`npm install -g @marxbiotech/openclaw\`

Source and releases: ${REPOSITORY}

---

${fs.readFileSync(readme, "utf8")}`,
    );
    // npm inventories every packed file; the receipt exceeds execFileSync's stdout buffer.
    const receiptPath = path.join(temporary, "pack.json");
    const receiptFd = fs.openSync(receiptPath, "w");
    try {
      run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
        cwd: packageRoot,
        stdio: ["ignore", receiptFd, "inherit"],
      });
    } finally {
      fs.closeSync(receiptFd);
    }
    const receipt = readJson(receiptPath);
    const filename = `marxbiotech-openclaw-${identity.version}.tgz`;
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0].filename, filename);
    const tarball = path.join(directory, filename);
    // Reuse the canonical inventory/import/native-payload checker after the scope adaptation.
    run(process.execPath, [
      "scripts/check-openclaw-package-tarball.mjs",
      "--require-bundled-workspace-deps",
      tarball,
    ]);
    const release = { ...identity, commit, tarball: filename, integrity: integrity(tarball) };
    writeJson(path.join(directory, "release.json"), release);
    console.log(JSON.stringify(release, null, 2));
  } finally {
    fs.writeFileSync(manifestPath, original);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function smoke(directory, fromRegistry = false) {
  const { release, tarball } = releaseBundle(directory);
  if (fromRegistry) {
    verifyPublishedRelease(await registryVersion(release.version), release);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "marxbiotech-npm-smoke-"));
  try {
    const prefix = path.join(temporary, "prefix");
    const userconfig = path.join(temporary, "npmrc");
    fs.writeFileSync(userconfig, "");
    const env = {
      ...process.env,
      npm_config_userconfig: userconfig,
      npm_config_cache: path.join(temporary, "npm-cache"),
      npm_config_prefix: prefix,
      PATH: `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_STATE_DIR: path.join(temporary, "state"),
      OPENCLAW_CONFIG_PATH: path.join(temporary, "state", "openclaw.json"),
      OPENCLAW_DISABLE_TELEMETRY: "1",
    };
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_TOKEN;
    const npmMajor = Number(capture("npm", ["--version"]).split(".")[0]);
    run(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--registry",
        REGISTRY,
        "--no-audit",
        "--no-fund",
        ...(npmMajor >= 12 ? [`--allow-scripts=${PACKAGE}`] : []),
        fromRegistry ? `${PACKAGE}@${release.version}` : tarball,
      ],
      { env },
    );
    const packageRoot = path.join(prefix, "lib", "node_modules", "@marxbiotech", "openclaw");
    const manifest = readJson(path.join(packageRoot, "package.json"));
    const buildInfo = readJson(path.join(packageRoot, "dist", "build-info.json"));
    assert.equal(manifest.name, PACKAGE);
    assert.equal(manifest.version, release.version);
    assert.equal(buildInfo.version, release.version);
    assert.equal(buildInfo.commit, release.commit);
    const executable = path.join(prefix, "bin", "openclaw");
    const version = capture(executable, ["--version"], { env });
    assert(version.includes(release.version), `Unexpected CLI version: ${version}`);
    run(executable, ["--help"], { env });
    run(executable, ["node", "--help"], { env });
    run(
      process.execPath,
      [
        "scripts/docker/verify-fs-safe-native.mjs",
        "--package-root",
        packageRoot,
        "--mode",
        "require",
      ],
      { env },
    );
    const sdk = pathToFileURL(path.join(packageRoot, "dist", "plugin-sdk", "acp-backend.js")).href;
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const sdk = await import(${JSON.stringify(sdk)});
      for (const name of ['registerAcpRuntimeBackend', 'getAcpRuntimeBackend']) {
        if (typeof sdk[name] !== 'function') throw new Error('Missing ACP SDK export: ' + name);
      }
    `,
      ],
      { env },
    );
    const plugins = JSON.parse(capture(executable, ["plugins", "list", "--json"], { env }));
    assert(
      Array.isArray(plugins.plugins),
      "Bundled plugin discovery did not return plugin inventory",
    );
    assert(plugins.plugins.length > 0, "Scoped installation lost its bundled plugins");
    const inspection = JSON.parse(
      capture(executable, ["plugins", "inspect", "memory-core", "--runtime", "--json"], { env }),
    );
    assert.equal(inspection.plugin.status, "loaded", JSON.stringify(inspection.plugin));
    const status = JSON.parse(capture(executable, ["update", "status", "--json"], { env }));
    assert.equal(fs.realpathSync(status.update.root), fs.realpathSync(packageRoot));
    assert.equal(status.update.installKind, "package");
    const registry = await registryVersion(status.update.registry.tag ?? "latest");
    assert.equal(
      status.update.registry.latestVersion,
      registry?.version,
      "Updater queried the wrong npm distribution",
    );
    console.log(
      `Verified ${PACKAGE}@${release.version} (${release.commit}) on ${process.platform}/${process.arch}`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function registryVersion(version) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(PACKAGE)}/${version}`, {
    signal: AbortSignal.timeout(30_000),
    headers: { "cache-control": "no-cache" },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Registry read failed: HTTP ${response.status}`);
  }
  return response.json();
}

export function verifyPublishedRelease(published, release) {
  assert(published, `Registry version ${PACKAGE}@${release.version} is not available`);
  assert.equal(published.name, PACKAGE);
  assert.equal(published.version, release.version);
  assert.equal(
    published.dist?.integrity,
    release.integrity,
    "Published version has different bytes; never overwrite it",
  );
}

async function publish(directory) {
  const { release, tarball } = releaseBundle(directory);
  assert.equal(process.env.GITHUB_REPOSITORY, "marxbiotech/openclaw");
  assert.equal(process.env.GITHUB_REF, `refs/tags/${release.tag}`);
  assert.equal(process.env.GITHUB_SHA, release.commit);
  const existing = await registryVersion(release.version);
  if (existing) {
    verifyPublishedRelease(existing, release);
    console.log("Exact artifact is already published; skipping immutable version publication.");
  } else {
    run("npm", [
      "publish",
      tarball,
      "--access",
      "public",
      "--provenance",
      "--tag",
      release.npmTag,
      "--registry",
      REGISTRY,
    ]);
  }
  // A failed or ambiguous publish is reconciled from exact bytes on rerun, never unpublished.
  const published = await registryVersion(release.version);
  assert(published, "Published version is not yet visible in the registry; rerun verification");
  verifyPublishedRelease(published, release);
  const selected = await registryVersion(release.npmTag);
  assert.equal(
    selected?.version,
    release.version,
    `npm ${release.npmTag} selector was not promoted`,
  );
  console.log(`Published ${PACKAGE}@${release.version} with ${release.npmTag}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value, output] = process.argv.slice(2);
  try {
    if (command === "identity") {
      console.log(
        JSON.stringify(releaseIdentity(value, readJson(path.join(ROOT, "package.json")).version)),
      );
    } else if (command === "pack" && value && output) {
      await pack(value, path.resolve(output));
    } else if (command === "smoke" && value) {
      await smoke(path.resolve(value));
    } else if (command === "verify" && value) {
      await smoke(path.resolve(value), true);
    } else if (command === "publish" && value) {
      await publish(path.resolve(value));
    } else {
      throw new Error(
        "Usage: marxbiotech-npm-release.mjs identity TAG | pack TAG OUTPUT_DIR | smoke ARTIFACT_DIR | publish ARTIFACT_DIR | verify ARTIFACT_DIR",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
