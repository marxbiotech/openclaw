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
    const result = resolveAcpNodeSpawnInvocation("acpx", ["claude", "prompt", "--session", "s1"]);
    if (process.platform !== "win32") {
      expect(result.command).toBe("acpx");
      expect(result.argv).toEqual(["claude", "prompt", "--session", "s1"]);
      expect(result.shell).toBeUndefined();
    }
  });

  it("unwraps .cmd shim entrypoint on simulated windows", async () => {
    // Build a fake .cmd shim that points to a JS entrypoint, then call
    // resolveWindowsSpawnProgram directly to verify .cmd → node resolution.
    // We can't easily override process.platform inside resolveAcpNodeSpawnInvocation
    // (it reads process.platform at call time), so we test the underlying
    // resolveWindowsSpawnProgram pipeline the same way client.test.ts does.
    const { resolveWindowsSpawnProgram, materializeWindowsSpawnProgram } =
      await import("../plugin-sdk/windows-spawn.js");

    const dir = await createTempDir();
    const scriptPath = path.join(dir, "acpx", "dist", "entry.js");
    const shimPath = path.join(dir, "acpx.cmd");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "console.log('ok')\n", "utf8");
    await writeFile(shimPath, `@ECHO off\r\n"%~dp0\\acpx\\dist\\entry.js" %*\r\n`, "utf8");

    const program = resolveWindowsSpawnProgram({
      command: shimPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      allowShellFallback: true,
    });
    const invocation = materializeWindowsSpawnProgram(program, [
      "claude",
      "prompt",
      "--session",
      "s1",
    ]);

    expect(invocation.command).toBe("C:\\node\\node.exe");
    expect(invocation.argv).toEqual([scriptPath, "claude", "prompt", "--session", "s1"]);
    expect(invocation.shell).toBeUndefined();
    expect(invocation.windowsHide).toBe(true);
  });

  it("falls back to shell mode for unresolved .cmd wrappers on simulated windows", async () => {
    const { resolveWindowsSpawnProgram, materializeWindowsSpawnProgram } =
      await import("../plugin-sdk/windows-spawn.js");

    const dir = await createTempDir();
    const shimPath = path.join(dir, "acpx.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const program = resolveWindowsSpawnProgram({
      command: shimPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      allowShellFallback: true,
    });
    const invocation = materializeWindowsSpawnProgram(program, ["claude", "prompt"]);

    expect(invocation.command).toBe(shimPath);
    expect(invocation.argv).toEqual(["claude", "prompt"]);
    expect(invocation.shell).toBe(true);
  });
});
