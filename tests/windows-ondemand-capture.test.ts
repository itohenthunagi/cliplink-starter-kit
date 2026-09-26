import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);

describe.skipIf(process.platform !== "win32")("Windowsオンデマンドキャプチャ補助処理", () => {
  it("サーバー死活確認・タイムアウト解釈・二重起動防止を検証できる", async () => {
    const token = "01234567-89ab-cdef-0123-456789abcdef";
    const shareBase = "https://gateway.example.test";
    const server = createServer((req, res) => {
      if (req.url === "/api/session") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token, mode: "cloud", shareBase, root: "", maxBytes: 1, shortcut: "off" }));
        return;
      }
      // shareBaseの欠落・空文字・不正値はfail closed(null返却)を検証するための派生応答。
      if (req.url === "/missing/api/session") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token, mode: "cloud", root: "", maxBytes: 1, shortcut: "off" }));
        return;
      }
      if (req.url === "/empty/api/session") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token, mode: "cloud", shareBase: "", root: "", maxBytes: 1, shortcut: "off" }));
        return;
      }
      if (req.url === "/invalid/api/session") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token, mode: "cloud", shareBase: "not-a-url", root: "", maxBytes: 1, shortcut: "off" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP server did not start");
      const command = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -Path @($env:CLIPLINK_TEST_HOTKEY_SOURCE, $env:CLIPLINK_TEST_ONDEMAND_SOURCE) -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')",
        "$foundSession = [CliplinkOnDemandCapture]::FetchSessionAsync($env:CLIPLINK_TEST_ORIGIN, 3000).GetAwaiter().GetResult()",
        "$missingSession = [CliplinkOnDemandCapture]::FetchSessionAsync('http://127.0.0.1:1', 300).GetAwaiter().GetResult()",
        // shareBaseキー自体が無い/空文字/URLとして不正、のいずれもnullへfail closedする(originへ推測フォールバックしない)。
        "$missingShareBaseSession = [CliplinkOnDemandCapture]::FetchSessionAsync($env:CLIPLINK_TEST_ORIGIN + '/missing', 3000).GetAwaiter().GetResult()",
        "$emptyShareBaseSession = [CliplinkOnDemandCapture]::FetchSessionAsync($env:CLIPLINK_TEST_ORIGIN + '/empty', 3000).GetAwaiter().GetResult()",
        "$invalidShareBaseSession = [CliplinkOnDemandCapture]::FetchSessionAsync($env:CLIPLINK_TEST_ORIGIN + '/invalid', 3000).GetAwaiter().GetResult()",
        "$parsedValid = [CliplinkOnDemandCapture]::ParseIdleTimeoutMs('12345', 999)",
        "$parsedInvalid = [CliplinkOnDemandCapture]::ParseIdleTimeoutMs('not-a-number', 999)",
        "$parsedNegative = [CliplinkOnDemandCapture]::ParseIdleTimeoutMs('-5', 999)",
        "$parsedEmpty = [CliplinkOnDemandCapture]::ParseIdleTimeoutMs($null, 999)",
        // 3引数版はテスト専用のガード名で二重起動防止だけを検証する。実装がSemaphoreになったため、
        // 既存実行中を模す側もSemaphoreで同じ名前空間を確保する(型が違うと名前衝突で例外になる)。
        "$heldGuard = New-Object System.Threading.Semaphore(1, 1, 'Global\\CliplinkOnDemandTest_Image')",
        "$heldGuard.WaitOne() | Out-Null",
        "$env:CLIPLINK_ORIGIN = 'http://127.0.0.1:1'",
        "$skippedCode = [CliplinkOnDemandCapture]::RunAsync('Image', 'C:\\nonexistent', 'Global\\CliplinkOnDemandTest_Image').GetAwaiter().GetResult()",
        "$heldGuard.Release() | Out-Null; $heldGuard.Close()",
        // 2引数版はImage/Videoで共通のガード名を使う(直列化)ため、
        // 'Global\\CliplinkOnDemand'を保持した状態でVideoを起動してもSKIPPEDになるはず。
        "$heldGlobalGuard = New-Object System.Threading.Semaphore(1, 1, 'Global\\CliplinkOnDemand')",
        "$heldGlobalGuard.WaitOne() | Out-Null",
        "$skippedSharedModeCode = [CliplinkOnDemandCapture]::RunAsync('Video', 'C:\\nonexistent').GetAwaiter().GetResult()",
        "$heldGlobalGuard.Release() | Out-Null; $heldGlobalGuard.Close()",
        // 成功経路のawait後release検証: FetchSessionAsyncの実await(接続拒否)でThreadPoolへ継続が移った後、
        // finallyでのRelease()が例外にならないことと、ガードが正しく解放・破棄され次回も再取得できることを確認する。
        // StartServerへは実在しない作業ディレクトリを渡し、Process.Startの同期例外(Win32Exception)をfinally通過後まで
        // 伝播させる。Mutex実装のままだとReleaseMutex()がApplicationExceptionへすり替え、かつCloseされず
        // 2回目がSKIPPEDになる回帰が過去に確認されている。
        "function Invoke-GuardedRun([string]$mode, [string]$repoRoot, [string]$guardName) { try { [CliplinkOnDemandCapture]::RunAsync($mode, $repoRoot, $guardName).GetAwaiter().GetResult() | Out-Null; return @{ threw = $false; excType = $null } } catch { $eff = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }; return @{ threw = $true; excType = $eff.GetType().FullName } } }",
        "$env:CLIPLINK_ORIGIN = 'http://127.0.0.1:1'",
        "$releaseFirst = Invoke-GuardedRun 'Image' 'C:\\nonexistent' 'Global\\CliplinkOnDemandTest_Release'",
        "$releaseSecond = Invoke-GuardedRun 'Image' 'C:\\nonexistent' 'Global\\CliplinkOnDemandTest_Release'",
        "@{ foundToken = $foundSession.Token; foundShareBase = $foundSession.ShareBase; missingSession = $missingSession; missingShareBaseSession = $missingShareBaseSession; emptyShareBaseSession = $emptyShareBaseSession; invalidShareBaseSession = $invalidShareBaseSession; parsedValid = $parsedValid; parsedInvalid = $parsedInvalid; parsedNegative = $parsedNegative; parsedEmpty = $parsedEmpty; skippedCode = $skippedCode; skippedSharedModeCode = $skippedSharedModeCode; releaseFirstThrew = $releaseFirst.threw; releaseFirstType = $releaseFirst.excType; releaseSecondThrew = $releaseSecond.threw; releaseSecondType = $releaseSecond.excType } | ConvertTo-Json -Compress",
      ].join("; ");
      const result = await run(
        "powershell.exe",
        ["-NoProfile", "-Sta", "-Command", command],
        {
          env: {
            ...process.env,
            CLIPLINK_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
            CLIPLINK_TEST_HOTKEY_SOURCE: resolve("scripts/windows-hotkey.cs"),
            CLIPLINK_TEST_ONDEMAND_SOURCE: resolve("scripts/windows-ondemand-capture.cs"),
          },
          timeout: 20000,
        },
      );
      // RunAsyncはSKIPPED/CAPTURED等の進捗もstdoutへ書くため、最終行のJSONだけを取り出す。
      const lines = result.stdout.trim().split(/\r?\n/);
      const parsed = JSON.parse(lines[lines.length - 1]);
      expect(parsed.foundToken).toBe(token);
      expect(parsed.foundShareBase).toBe(shareBase);
      expect(parsed.missingSession).toBeNull();
      expect(parsed.missingShareBaseSession).toBeNull();
      expect(parsed.emptyShareBaseSession).toBeNull();
      expect(parsed.invalidShareBaseSession).toBeNull();
      expect(parsed.parsedValid).toBe(12345);
      expect(parsed.parsedInvalid).toBe(999);
      expect(parsed.parsedNegative).toBe(999);
      expect(parsed.parsedEmpty).toBe(999);
      expect(parsed.skippedCode).toBe(2);
      expect(parsed.skippedSharedModeCode).toBe(2);
      // 成功経路でawait後にfinallyのRelease()が例外化しないこと(Mutexのスレッド所有権バグの回帰防止)。
      expect(parsed.releaseFirstThrew).toBe(true);
      expect(parsed.releaseFirstType).toBe("System.ComponentModel.Win32Exception");
      // ガードが正しく解放・破棄され、2回目も(SKIPPEDにならず)同じ経路を再実行できること。
      expect(parsed.releaseSecondThrew).toBe(true);
      expect(parsed.releaseSecondType).toBe("System.ComponentModel.Win32Exception");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("録画開始後の候補を既定保存先とTempStateから選び、古いmp4を除外する", async () => {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -Path @($env:CLIPLINK_TEST_HOTKEY_SOURCE, $env:CLIPLINK_TEST_ONDEMAND_SOURCE) -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')",
      "$root = Join-Path ([System.IO.Path]::GetTempPath()) ('cliplink-video-candidate-' + [Guid]::NewGuid().ToString('N'))",
      "$videos = Join-Path $root 'Videos\\Screen Recordings'; $temp = Join-Path $root 'TempState\\Recordings'",
      "New-Item -ItemType Directory -Force -Path $videos, $temp | Out-Null",
      "try {",
      "  $start = [DateTime]::UtcNow.AddMinutes(-1)",
      "  $old = Join-Path $videos 'old.mp4'; [IO.File]::WriteAllBytes($old, [byte[]](1, 2, 3)); [IO.File]::SetLastWriteTimeUtc($old, $start.AddSeconds(-1))",
      "  $default = Join-Path $videos 'default.mp4'; [IO.File]::WriteAllBytes($default, [byte[]](4, 5, 6)); [IO.File]::SetLastWriteTimeUtc($default, $start.AddSeconds(2))",
      "  $preSave = Join-Path $temp 'pre-save.mp4'; [IO.File]::WriteAllBytes($preSave, [byte[]](7, 8, 9)); [IO.File]::SetLastWriteTimeUtc($preSave, $start.AddSeconds(5))",
      "  $candidate = [CliplinkOnDemandCapture]::FindNewestVideoCandidate([string[]]@($videos, $temp), $start)",
      "  $folders = [CliplinkOnDemandCapture]::GetVideoFolders()",
      "  @{ candidate = $candidate.FullName; defaultFolder = $folders[0]; tempFolder = $folders[1] } | ConvertTo-Json -Compress",
      "} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }",
    ].join("; ");
    const result = await run(
      "powershell.exe",
      ["-NoProfile", "-Sta", "-Command", command],
      {
        env: {
          ...process.env,
          CLIPLINK_TEST_HOTKEY_SOURCE: resolve("scripts/windows-hotkey.cs"),
          CLIPLINK_TEST_ONDEMAND_SOURCE: resolve("scripts/windows-ondemand-capture.cs"),
        },
        timeout: 20000,
      },
    );
    const lines = result.stdout.trim().split(/\r?\n/);
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.candidate).toMatch(/TempState[\\/]Recordings[\\/]pre-save\.mp4$/i);
    expect(parsed.defaultFolder).toMatch(/[\\/]Screen Recordings$/i);
    expect(parsed.tempFolder).toMatch(/[\\/]Packages[\\/]Microsoft\.ScreenSketch_8wekyb3d8bbwe[\\/]TempState[\\/]Recordings$/i);
  });

  it("物理トリガーキーが押されたままの間はSnipping Tool起動用の合成入力を待たせる(WaitForKeysReleasedAsync)", async () => {
    // 物理Ctrl+Alt+Rが押しっぱなしのままWin+Shift+Rを合成送信すると、OSに渡る同時押下状態が
    // Ctrl+Alt+Win+Shift+Rになり録画ショートカットと一致せず無音で失敗する回帰を防ぐテスト。
    // 本物のCtrl/Alt/S/Rではなく、どのショートカットにも割り当てられていない仮想キー(VK_F15)を
    // このテスト専用のkeybd_event宣言で押下/解放し、待機ロジック(WaitForKeysReleasedAsync)だけを検証する。
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -Path @($env:CLIPLINK_TEST_HOTKEY_SOURCE, $env:CLIPLINK_TEST_ONDEMAND_SOURCE) -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')",
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class CliplinkTestKeyInput { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte key, byte scan, uint flags, System.UIntPtr extra); }'",
      "$vKey = 0x7E", // VK_F15: 物理キーボードに存在せずどのショートカットにも割り当てられていない安全な仮想キー
      "try {",
      "  $swImmediate = [System.Diagnostics.Stopwatch]::StartNew()",
      "  $immediate = [CliplinkOnDemandCapture]::WaitForKeysReleasedAsync([int[]]@($vKey), [TimeSpan]::FromMilliseconds(500), [TimeSpan]::FromMilliseconds(20)).GetAwaiter().GetResult()",
      "  $swImmediate.Stop()",
      "  [CliplinkTestKeyInput]::keybd_event($vKey, 0, 0, [UIntPtr]::Zero)",
      "  $swTimedOut = [System.Diagnostics.Stopwatch]::StartNew()",
      "  $timedOut = [CliplinkOnDemandCapture]::WaitForKeysReleasedAsync([int[]]@($vKey), [TimeSpan]::FromMilliseconds(400), [TimeSpan]::FromMilliseconds(25)).GetAwaiter().GetResult()",
      "  $swTimedOut.Stop()",
      "  $releaseTask = [CliplinkOnDemandCapture]::WaitForKeysReleasedAsync([int[]]@($vKey), [TimeSpan]::FromSeconds(3), [TimeSpan]::FromMilliseconds(20))",
      "  Start-Sleep -Milliseconds 150",
      "  [CliplinkTestKeyInput]::keybd_event($vKey, 0, 2, [UIntPtr]::Zero)",
      "  $swReleased = [System.Diagnostics.Stopwatch]::StartNew()",
      "  $releasedInTime = $releaseTask.GetAwaiter().GetResult()",
      "  $swReleased.Stop()",
      "} finally {",
      "  [CliplinkTestKeyInput]::keybd_event($vKey, 0, 2, [UIntPtr]::Zero)", // 押しっぱなし状態が残らないよう保険で解放
      "}",
      "@{ immediate = $immediate; immediateElapsedMs = $swImmediate.ElapsedMilliseconds; timedOut = $timedOut; timedOutElapsedMs = $swTimedOut.ElapsedMilliseconds; releasedInTime = $releasedInTime; releasedElapsedMs = $swReleased.ElapsedMilliseconds + 150 } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = await run(
      "powershell.exe",
      ["-NoProfile", "-Sta", "-Command", command],
      {
        env: {
          ...process.env,
          CLIPLINK_TEST_HOTKEY_SOURCE: resolve("scripts/windows-hotkey.cs"),
          CLIPLINK_TEST_ONDEMAND_SOURCE: resolve("scripts/windows-ondemand-capture.cs"),
        },
        timeout: 20000,
      },
    );
    const lines = result.stdout.trim().split(/\r?\n/);
    const parsed = JSON.parse(lines[lines.length - 1]);
    // キーが押されていなければ即座に(ポーリング待ちなしで)trueが返る。
    expect(parsed.immediate).toBe(true);
    expect(parsed.immediateElapsedMs).toBeLessThan(300);
    // 押されっぱなしのままだとtimeout(400ms)まで待ってfalseを返す(=送信を待たせている証拠)。
    expect(parsed.timedOut).toBe(false);
    expect(parsed.timedOutElapsedMs).toBeGreaterThanOrEqual(380);
    expect(parsed.timedOutElapsedMs).toBeLessThan(1500);
    // 待機開始後(3秒timeout)にキーが解放されれば、timeoutを待たずtrueで返る(=固定sleepでなくポーリングである証拠)。
    expect(parsed.releasedInTime).toBe(true);
    expect(parsed.releasedElapsedMs).toBeLessThan(2500);
  });
});
