import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);

describe.skipIf(process.platform !== "win32")("Windows Start Menuショートカットの冪等な設置・撤去", () => {
  it("実際のStart Menuには触れず、一時フォルダへCtrl+Alt+S/Rの.lnkを作成・再実行・削除できる", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "cliplink-shortcut-"));
    const install = resolve("scripts/windows-install-shortcuts.ps1");
    const uninstall = resolve("scripts/windows-uninstall-shortcuts.ps1");
    const repoRoot = resolve(".");
    try {
      const runInstall = () =>
        run(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", install, "-TargetDir", targetDir, "-RepoRoot", repoRoot],
          { timeout: 20000 },
        );
      await runInstall();
      await runInstall(); // 冪等性: 既存ショートカットへの再作成でエラーにならないこと

      const imagePath = join(targetDir, "Cliplink 範囲撮影.lnk");
      const videoPath = join(targetDir, "Cliplink 範囲録画.lnk");
      const inspect = [
        "$ErrorActionPreference = 'Stop'",
        "$shell = New-Object -ComObject WScript.Shell",
        `$img = $shell.CreateShortcut('${imagePath.replace(/'/g, "''")}')`,
        `$vid = $shell.CreateShortcut('${videoPath.replace(/'/g, "''")}')`,
        "@{ imgHotkey = $img.Hotkey; imgArgs = $img.Arguments; vidHotkey = $vid.Hotkey; vidArgs = $vid.Arguments } | ConvertTo-Json -Compress",
      ].join("; ");
      const inspected = await run("powershell.exe", ["-NoProfile", "-Command", inspect], { timeout: 15000 });
      const parsed = JSON.parse(inspected.stdout.trim());
      // WScript.Shellは設定した修飾子順を正規化して保持する(CTRL+ALT+S -> Alt+Ctrl+S)。
      expect(parsed.imgHotkey).toBe("Alt+Ctrl+S");
      expect(parsed.vidHotkey).toBe("Alt+Ctrl+R");
      expect(parsed.imgArgs).toContain("-Mode Image");
      expect(parsed.imgArgs).toContain("windows-ondemand-capture.ps1");
      expect(parsed.vidArgs).toContain("-Mode Video");

      const entries = await readdir(targetDir);
      expect(entries.sort()).toEqual(["Cliplink 範囲撮影.lnk", "Cliplink 範囲録画.lnk"]);

      const runUninstall = () =>
        run(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", uninstall, "-TargetDir", targetDir],
          { timeout: 20000 },
        );
      await runUninstall();
      await runUninstall(); // 冪等性: 既に無い状態での再実行でエラーにならないこと

      await expect(readdir(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
