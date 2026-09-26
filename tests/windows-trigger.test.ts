import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);

// RegisterHotKey/Application.Runは実際のグローバルホットキー登録とメッセージループを伴うため
// (ユーザーの物理Ctrl+Alt+S/Rと衝突しかねない)、ここではCliplinkTriggerAppを一切インスタンス化せず、
// config読取・引数組み立て・二重起動ガード・状態ファイルの静的ロジックだけを検証する。
describe.skipIf(process.platform !== "win32")("Windows常駐トリガーの静的ロジック", () => {
  it("config読取・起動引数・二重起動ガード・状態ファイルを検証できる", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cliplink-trigger-"));
    try {
      const configPath = join(tempDir, "trigger-config.json");
      const missingConfigPath = join(tempDir, "missing-config.json");
      const statusPath = join(tempDir, "trigger-status.json");
      const command = [
        "$ErrorActionPreference = 'Stop'",
        // 実際のEXEと同じく、撮影・送信処理のソースもまとめてコンパイルできること。
        "Add-Type -Path @($env:CLIPLINK_TEST_SOURCE, $env:CLIPLINK_TEST_HOTKEY_SOURCE, $env:CLIPLINK_TEST_ONDEMAND_SOURCE) -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')",
        // config読取: ConvertTo-Jsonが書いたバックスラッシュのエスケープを正しく戻せること。
        "@{ repoRoot = 'C:\\Users\\test\\MyProjects\\cliplink' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CLIPLINK_TEST_CONFIG -Encoding UTF8",
        "$repoRoot = [CliplinkTriggerConfig]::ReadRepoRoot($env:CLIPLINK_TEST_CONFIG)",
        "$missingRepoRoot = [CliplinkTriggerConfig]::ReadRepoRoot($env:CLIPLINK_TEST_MISSING_CONFIG)",
        // ショートカット指定: 修飾キー必須・英数字/F1〜F24のみを受け付け、表示形式へ戻せること。
        "$m = [uint32]0; $k = [uint32]0",
        "$okDefault = [CliplinkHotkeySpec]::TryParse('Ctrl+Alt+S', [ref]$m, [ref]$k)",
        "$formatted = [CliplinkHotkeySpec]::Format($m, $k)",
        "$okF = [CliplinkHotkeySpec]::TryParse('ctrl + shift + f12', [ref]$m, [ref]$k)",
        "$keyF = $k",
        "$ngNoModifier = [CliplinkHotkeySpec]::TryParse('S', [ref]$m, [ref]$k)",
        "$ngShiftOnly = [CliplinkHotkeySpec]::TryParse('Shift+S', [ref]$m, [ref]$k)",
        "$ngTwoKeys = [CliplinkHotkeySpec]::TryParse('Ctrl+A+B', [ref]$m, [ref]$k)",
        "$displayEmpty = [CliplinkHotkeySpec]::Display('')",
        // PowerShellの標準出力は日本語を別の文字コードへ変えるため、「なし」は文字コードで比べる。
        "$displayEmptyCodes = [string]::Join(',', ($displayEmpty.ToCharArray() | ForEach-Object { [int]$_ }))",
        "$displayDefault = [CliplinkHotkeySpec]::Display('Ctrl+Alt+R')",
        // 撮影前に離されるのを待つキー: 変更後の組み合わせ（Shift・Winを含む）もそのまま待てること。
        "$heldShift = [CliplinkHotkeySpec]::HeldKeys('Ctrl+Shift+F2') -join ','",
        "$heldWin = [CliplinkHotkeySpec]::HeldKeys('Win+Alt+S') -join ','",
        "$heldNone = @([CliplinkHotkeySpec]::HeldKeys('')).Count",
        // 記録: repo配下の .cliplink/capture.log へ追記し、存在しないrepoを渡しても記録先を変えないこと。
        "[CliplinkLog]::Use($env:CLIPLINK_TEST_REPO); [CliplinkLog]::Write('TEST first')",
        "[CliplinkLog]::Use('C:\\nonexistent-cliplink-repo'); [CliplinkLog]::Write('TEST second')",
        "$logLines = @(Get-Content -LiteralPath (Join-Path $env:CLIPLINK_TEST_REPO '.cliplink\\capture.log') | ForEach-Object { $_.Substring(20) }) -join '|'",
        // 設定の保存・読込: 未保存なら初期値、保存した値はそのまま戻ること。
        "$defaults = [CliplinkHotkeySettings]::Load($env:CLIPLINK_TEST_HOTKEYS)",
        "$custom = New-Object CliplinkHotkeySettings",
        "$custom.Image = 'Ctrl+Shift+1'; $custom.Video = 'Alt+F9'; $custom.Open = 'Ctrl+Alt+L'",
        "$custom.Save($env:CLIPLINK_TEST_HOTKEYS)",
        "$loaded = [CliplinkHotkeySettings]::Load($env:CLIPLINK_TEST_HOTKEYS)",
        // 二重起動ガード: createdNewが唯一のインスタンスである間だけtrueを保つこと。
        "$guard1 = $null",
        "$created1 = [CliplinkTriggerGuard]::IsPrimaryInstance('Global\\CliplinkTriggerTest_Guard', [ref]$guard1)",
        "$guard2 = $null",
        "$created2 = [CliplinkTriggerGuard]::IsPrimaryInstance('Global\\CliplinkTriggerTest_Guard', [ref]$guard2)",
        "$guard2IsNull = $null -eq $guard2",
        "$guard1.Close()",
        "$guard3 = $null",
        "$created3 = [CliplinkTriggerGuard]::IsPrimaryInstance('Global\\CliplinkTriggerTest_Guard', [ref]$guard3)",
        "$guard3.Close()",
        // 状態ファイル: 上書きが読取側から見て常に完全な内容になり、.tmpが残らないこと。
        // PowerShellは文字列パラメータへの$nullを既定で\"\"へ変換してしまうため、実際のC#呼び出し(常にnull)を
        // 忠実に再現するには[NullString]::Valueで明示的に本物のnullを渡す必要がある。
        "$json1 = [CliplinkTriggerStatus]::BuildJson(1234, 'C:\\exe\\CliplinkTrigger.exe', '2026-01-01T00:00:00.000Z', $true, $false, [NullString]::Value, [NullString]::Value, [NullString]::Value)",
        "[CliplinkTriggerStatus]::WriteAtomic($env:CLIPLINK_TEST_STATUS, $json1)",
        "$read1 = Get-Content -LiteralPath $env:CLIPLINK_TEST_STATUS -Raw | ConvertFrom-Json",
        "$json2 = [CliplinkTriggerStatus]::BuildJson(1234, 'C:\\exe\\CliplinkTrigger.exe', '2026-01-01T00:00:00.000Z', $true, $true, '2026-01-01T00:01:00.000Z', 'S', 'bad \"path\" C:\\x')",
        "[CliplinkTriggerStatus]::WriteAtomic($env:CLIPLINK_TEST_STATUS, $json2)",
        "$read2 = Get-Content -LiteralPath $env:CLIPLINK_TEST_STATUS -Raw | ConvertFrom-Json",
        "$tmpLeftover = Test-Path -LiteralPath ($env:CLIPLINK_TEST_STATUS + '.tmp')",
        "@{ repoRoot = $repoRoot; missingRepoRoot = $missingRepoRoot; okDefault = $okDefault; formatted = $formatted; okF = $okF; keyF = $keyF; ngNoModifier = $ngNoModifier; ngShiftOnly = $ngShiftOnly; ngTwoKeys = $ngTwoKeys; displayEmptyCodes = $displayEmptyCodes; displayDefault = $displayDefault; heldShift = $heldShift; heldWin = $heldWin; heldNone = $heldNone; logLines = $logLines; defaultImage = $defaults.Image; defaultVideo = $defaults.Video; defaultOpen = $defaults.Open; loadedImage = $loaded.Image; loadedVideo = $loaded.Video; loadedOpen = $loaded.Open;created1 = $created1; created2 = $created2; guard2IsNull = $guard2IsNull; created3 = $created3; hotkeyS1 = $read1.hotkeyS; hotkeyR1 = $read1.hotkeyR; lastTriggeredAtUtc1 = $read1.lastTriggeredAtUtc; hotkeyR2 = $read2.hotkeyR; lastTriggeredKey2 = $read2.lastTriggeredKey; lastError2 = $read2.lastError; tmpLeftover = $tmpLeftover } | ConvertTo-Json -Compress",
      ].join("; ");
      const result = await run(
        "powershell.exe",
        ["-NoProfile", "-Sta", "-Command", command],
        {
          env: {
            ...process.env,
            CLIPLINK_TEST_SOURCE: resolve("scripts/windows-trigger.cs"),
            CLIPLINK_TEST_HOTKEY_SOURCE: resolve("scripts/windows-hotkey.cs"),
            CLIPLINK_TEST_ONDEMAND_SOURCE: resolve("scripts/windows-ondemand-capture.cs"),
            CLIPLINK_TEST_HOTKEYS: join(tempDir, "hotkeys.json"),
            CLIPLINK_TEST_CONFIG: configPath,
            CLIPLINK_TEST_MISSING_CONFIG: missingConfigPath,
            CLIPLINK_TEST_STATUS: statusPath,
            CLIPLINK_TEST_REPO: tempDir,
          },
          timeout: 90000,
        },
      );
      const lines = result.stdout.trim().split(/\r?\n/);
      const parsed = JSON.parse(lines[lines.length - 1]);
      expect(parsed.repoRoot).toBe("C:\\Users\\test\\MyProjects\\cliplink");
      expect(parsed.missingRepoRoot).toBeNull();
      expect(parsed.okDefault).toBe(true);
      expect(parsed.formatted).toBe("Ctrl+Alt+S");
      expect(parsed.okF).toBe(true);
      expect(parsed.keyF).toBe(0x7b);
      expect(parsed.ngNoModifier).toBe(false);
      expect(parsed.ngShiftOnly).toBe(false);
      expect(parsed.ngTwoKeys).toBe(false);
      expect(parsed.displayEmptyCodes).toBe([..."なし"].map((c) => c.charCodeAt(0)).join(","));
      expect(parsed.displayDefault).toBe("Ctrl + Alt + R");
      // F2=0x71, Ctrl=0x11, Shift=0x10 / S=0x53, Alt=0x12, 左右Win=0x5B,0x5C
      expect(parsed.heldShift).toBe("113,17,16");
      expect(parsed.heldWin).toBe("83,18,91,92");
      expect(parsed.heldNone).toBe(0);
      expect(parsed.logLines).toBe("TEST first|TEST second");
      expect([parsed.defaultImage, parsed.defaultVideo, parsed.defaultOpen]).toEqual(["Ctrl+Alt+S", "Ctrl+Alt+R", ""]);
      expect([parsed.loadedImage, parsed.loadedVideo, parsed.loadedOpen]).toEqual(["Ctrl+Shift+1", "Alt+F9", "Ctrl+Alt+L"]);
      expect(parsed.created1).toBe(true);
      expect(parsed.created2).toBe(false);
      expect(parsed.guard2IsNull).toBe(true);
      expect(parsed.created3).toBe(true);
      expect(parsed.hotkeyS1).toBe("registered");
      expect(parsed.hotkeyR1).toBe("unavailable");
      expect(parsed.lastTriggeredAtUtc1).toBeNull();
      expect(parsed.hotkeyR2).toBe("registered");
      expect(parsed.lastTriggeredKey2).toBe("S");
      expect(parsed.lastError2).toBe('bad "path" C:\\x');
      expect(parsed.tmpLeftover).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    // 3ファイルをまとめてコンパイルするため、既定の20秒では足りないことがある。
  }, 90000);
});
