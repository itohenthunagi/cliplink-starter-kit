import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);

// -SkipLaunchで常にコンパイルしたCliplinkTrigger.exeの起動を止め、実際のグローバルホットキー登録
// (物理Ctrl+Alt+S/Rと衝突しかねない)を一切発生させない。InstallDir/StartupDir/LegacyShortcutDirも
// すべて一時フォルダへ差し替え、実際のLocalAppData/Startup/Start Menuには触れない。
describe.skipIf(process.platform !== "win32")("Windows常駐トリガーの冪等な設置・撤去", () => {
  it(
    "一時フォルダへexe・config・Startupショートカットを作成・再実行・削除できる",
    async () => {
      const repoRoot = resolve(".");
      const install = resolve("scripts/windows-install-trigger.ps1");
      const uninstall = resolve("scripts/windows-uninstall-trigger.ps1");
      const installRoot = await mkdtemp(join(tmpdir(), "cliplink-trigger-install-"));
      const installDir = join(installRoot, "Cliplink", "Trigger");
      const startupDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-startup-"));
      const legacyShortcutDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-legacy-"));
      try {
        const runInstall = () =>
          run(
            "powershell.exe",
            [
              "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", install,
              "-RepoRoot", repoRoot,
              "-InstallDir", installDir,
              "-StartupDir", startupDir,
              "-ProgramsDir", startupDir,
              "-LegacyShortcutDir", legacyShortcutDir,
              "-SkipLaunch",
            ],
            { timeout: 60000 },
          );
        await runInstall();
        await runInstall(); // 冪等性: 再実行(再コンパイル・上書き)でエラーにならないこと

        const exePath = join(installDir, "CliplinkTrigger.exe");
        const configPath = join(installDir, "trigger-config.json");
        const shortcutPath = join(startupDir, "Cliplink Trigger.lnk");

        const exeStats = await import("node:fs/promises").then((fs) => fs.stat(exePath));
        expect(exeStats.size).toBeGreaterThan(0);

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.repoRoot).toBe(repoRoot);

        const inspect = [
          "$ErrorActionPreference = 'Stop'",
          "$shell = New-Object -ComObject WScript.Shell",
          `$sc = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
          "@{ targetPath = $sc.TargetPath; windowStyle = $sc.WindowStyle } | ConvertTo-Json -Compress",
        ].join("; ");
        const inspected = await run("powershell.exe", ["-NoProfile", "-Command", inspect], { timeout: 15000 });
        const shortcut = JSON.parse(inspected.stdout.trim());
        expect(shortcut.targetPath.toLowerCase()).toBe(exePath.toLowerCase());
        expect(shortcut.windowStyle).toBe(7);

        // 管理画面を開くスタートメニュー項目（補助処理の Open モード）。
        const dashboardPath = join(startupDir, "Cliplink.lnk");
        const dashboardInspect = [
          "$shell = New-Object -ComObject WScript.Shell",
          `$sc = $shell.CreateShortcut('${dashboardPath.replace(/'/g, "''")}')`,
          "@{ targetPath = $sc.TargetPath; arguments = $sc.Arguments } | ConvertTo-Json -Compress",
        ].join("; ");
        const dashboard = JSON.parse(
          (await run("powershell.exe", ["-NoProfile", "-Command", dashboardInspect], { timeout: 15000 })).stdout.trim(),
        );
        expect(dashboard.targetPath.toLowerCase()).toContain("powershell.exe");
        expect(dashboard.arguments).toContain("windows-ondemand-capture.ps1");
        expect(dashboard.arguments).toContain("-Mode Open");

        const runUninstall = (installDirArgument = installDir) =>
          run(
            "powershell.exe",
            [
              "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", uninstall,
              "-InstallDir", installDirArgument,
              "-StartupDir", startupDir,
              "-ProgramsDir", startupDir,
              "-LegacyShortcutDir", legacyShortcutDir,
            ],
            { timeout: 30000 },
          );
        const statusPath = join(installDir, "trigger-status.json");
        const statusTempPath = `${statusPath}.tmp`;
        const unrelatedPath = join(installDir, "user-data.txt");
        await writeFile(statusPath, "{}", "utf8");
        await writeFile(statusTempPath, "partial status", "utf8");
        await writeFile(unrelatedPath, "preserve this", "utf8");

        // `..` を含むカスタムInstallDirも絶対パスへ解決し、既知ファイルだけを削除する。
        const installDirAlias = `${join(installRoot, "Cliplink")}\\not-created\\..\\Trigger`;
        await runUninstall(installDirAlias);

        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(exePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(statusPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(statusTempPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(shortcutPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(startupDir, "Cliplink.lnk"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(unrelatedPath, "utf8")).toBe("preserve this");

        await runUninstall(installDirAlias); // 冪等: 他ファイルを残した状態でも再実行できる。
        expect(await readFile(unrelatedPath, "utf8")).toBe("preserve this");

        await rm(unrelatedPath, { force: true });
        await runUninstall(installDirAlias); // 所有ファイルが残っていない任意の空フォルダは削除対象と推定しない。
        expect(await readdir(installDir)).toEqual([]);
      } finally {
        await rm(installRoot, { recursive: true, force: true });
        await rm(startupDir, { recursive: true, force: true });
        await rm(legacyShortcutDir, { recursive: true, force: true });
      }
    },
    60000,
  );

  it("アプリ用の目印がない任意フォルダは一切変更しない", async () => {
    const installDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-unrelated-"));
    const startupDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-unrelated-startup-"));
    const legacyShortcutDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-unrelated-legacy-"));
    const unrelatedPath = join(installDir, "user-data.txt");
    const startupLink = join(startupDir, "Cliplink Trigger.lnk");
    const legacyLink = join(legacyShortcutDir, "Cliplink 範囲撮影.lnk");
    try {
      await writeFile(unrelatedPath, "keep", "utf8");
      await writeFile(startupLink, "startup keep", "utf8");
      await writeFile(legacyLink, "legacy keep", "utf8");
      const result = await run(
        "powershell.exe",
        [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/windows-uninstall-trigger.ps1"),
          "-InstallDir", installDir,
          "-StartupDir", startupDir,
              "-ProgramsDir", startupDir,
          "-LegacyShortcutDir", legacyShortcutDir,
        ],
        { timeout: 30000 },
      );
      expect(result.stdout).toContain("SKIPPED unrelated InstallDir");
      expect(await readFile(unrelatedPath, "utf8")).toBe("keep");
      expect(await readFile(startupLink, "utf8")).toBe("startup keep");
      expect(await readFile(legacyLink, "utf8")).toBe("legacy keep");
    } finally {
      await rm(installDir, { recursive: true, force: true });
      await rm(startupDir, { recursive: true, force: true });
      await rm(legacyShortcutDir, { recursive: true, force: true });
    }
  });

  it("空のカスタムTriggerフォルダを名前だけで削除しない", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "cliplink-trigger-unrelated-empty-"));
    const installDir = join(installRoot, "Trigger");
    const startupDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-unrelated-empty-startup-"));
    const legacyShortcutDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-unrelated-empty-legacy-"));
    const startupLink = join(startupDir, "Cliplink Trigger.lnk");
    const legacyLink = join(legacyShortcutDir, "Cliplink 範囲撮影.lnk");
    try {
      await mkdir(installDir);
      await writeFile(startupLink, "startup keep", "utf8");
      await writeFile(legacyLink, "legacy keep", "utf8");
      const result = await run(
        "powershell.exe",
        [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/windows-uninstall-trigger.ps1"),
          "-InstallDir", installDir,
          "-StartupDir", startupDir,
              "-ProgramsDir", startupDir,
          "-LegacyShortcutDir", legacyShortcutDir,
        ],
        { timeout: 30000 },
      );
      expect(result.stdout).toContain("SKIPPED unrelated InstallDir");
      expect(await readdir(installDir)).toEqual([]);
      expect(await readFile(startupLink, "utf8")).toBe("startup keep");
      expect(await readFile(legacyLink, "utf8")).toBe("legacy keep");
    } finally {
      await rm(installRoot, { recursive: true, force: true });
      await rm(startupDir, { recursive: true, force: true });
      await rm(legacyShortcutDir, { recursive: true, force: true });
    }
  });

  it("所有ファイルがあるカスタムフォルダは空になった後に削除する", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "cliplink-trigger-owned-empty-"));
    const installDir = join(installRoot, "custom-install");
    const startupDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-owned-empty-startup-"));
    const legacyShortcutDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-owned-empty-legacy-"));
    try {
      await mkdir(installDir);
      await writeFile(join(installDir, "trigger-config.json"), "{}", "utf8");
      const result = await run(
        "powershell.exe",
        [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/windows-uninstall-trigger.ps1"),
          "-InstallDir", installDir,
          "-StartupDir", startupDir,
              "-ProgramsDir", startupDir,
          "-LegacyShortcutDir", legacyShortcutDir,
        ],
        { timeout: 30000 },
      );
      expect(result.stdout).toContain("REMOVED");
      await expect(import("node:fs/promises").then((fs) => fs.stat(installDir))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(installRoot, { recursive: true, force: true });
      await rm(startupDir, { recursive: true, force: true });
      await rm(legacyShortcutDir, { recursive: true, force: true });
    }
  });
});
