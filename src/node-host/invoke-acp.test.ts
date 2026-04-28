import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { resolveAcpNodeSpawnInvocation } from "./invoke-acp.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("invoke-acp-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("resolveAcpNodeSpawnInvocation", () => {
  it("passes through command and args on non-windows platforms", () => {
    // On darwin/linux the function should return the command unchanged
    // (resolveWindowsSpawnProgram is a no-op on non-win32)
    const result = resolveAcpNodeSpawnInvocation("acpx", ["claude", "prompt", "--session", "s1"], {
      platform: "linux",
      env: {},
      execPath: "/usr/bin/node",
    });
    expect(result.command).toBe("acpx");
    expect(result.argv).toEqual(["claude", "prompt", "--session", "s1"]);
    expect(result.shell).toBeUndefined();
    expect(result.windowsHide).toBeUndefined();
  });

  it("unwraps .cmd shim entrypoint on simulated windows", async () => {
    const dir = await createTempDir();
    const scriptPath = path.join(dir, "acpx", "dist", "entry.js");
    const shimPath = path.join(dir, "acpx.cmd");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "console.log('ok')\n", "utf8");
    await writeFile(shimPath, `@ECHO off\r\n"%~dp0\\acpx\\dist\\entry.js" %*\r\n`, "utf8");

    // resolveAcpNodeSpawnInvocation accepts an injectable runtime so we can
    // simulate Windows without mocking process.platform.
    const result = resolveAcpNodeSpawnInvocation(
      shimPath,
      ["claude", "prompt", "--session", "s1"],
      {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
      },
    );

    expect(result.command).toBe("C:\\node\\node.exe");
    expect(result.argv).toEqual([scriptPath, "claude", "prompt", "--session", "s1"]);
    expect(result.shell).toBeUndefined();
    expect(result.windowsHide).toBe(true);
  });

  it("falls back to shell mode for unresolved .cmd wrappers on simulated windows", async () => {
    const dir = await createTempDir();
    const shimPath = path.join(dir, "acpx.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const result = resolveAcpNodeSpawnInvocation(shimPath, ["claude", "prompt"], {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(result.command).toBe(shimPath);
    expect(result.argv).toEqual(["claude", "prompt"]);
    expect(result.shell).toBe(true);
  });
});
