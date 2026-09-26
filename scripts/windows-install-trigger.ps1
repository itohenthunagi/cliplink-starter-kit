param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Cliplink\Trigger'),
    [string]$StartupDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'),
    [string]$LegacyShortcutDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cliplink'),
    # 管理画面を開く「Cliplink」ショートカットの置き場所（スタートメニュー）。テストでは一時フォルダを渡す。
    [string]$ProgramsDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    # テスト・検証用。実運用では常に起動する(既定false)。
    [switch]$SkipLaunch
)
$ErrorActionPreference = 'Stop'

$sourcePath = Join-Path $PSScriptRoot 'windows-trigger.cs'
if (-not (Test-Path -LiteralPath $sourcePath)) { throw "windows-trigger.cs not found: $sourcePath" }

$exePath = Join-Path $InstallDir 'CliplinkTrigger.exe'
$configPath = Join-Path $InstallDir 'trigger-config.json'
$shortcutPath = Join-Path $StartupDir 'Cliplink Trigger.lnk'

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null

# 旧Start Menu .lnk(Ctrl+Alt+S/R Hotkey)方式が残っていれば安全に除去する(既に撤去済みでも冪等)。
$legacyUninstall = Join-Path $PSScriptRoot 'windows-uninstall-shortcuts.ps1'
if (Test-Path -LiteralPath $legacyUninstall) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $legacyUninstall -TargetDir $LegacyShortcutDir | Out-Null
}

# 実行中の旧バージョンを停止する。導入先と完全一致するものに加え、以前の導入が別の場所
# （例: Codexの隔離フォルダ ...\Packages\<アプリ>\LocalCache\Local\Cliplink\Trigger\）で動き続けている場合も止める。
# 止めないと新しい版が「既に起動中」と判断して即終了し、旧版が残り続ける（2026-09-26に発生）。
Get-CimInstance Win32_Process -Filter "Name = 'CliplinkTrigger.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and (($_.ExecutablePath -ieq $exePath) -or ($_.ExecutablePath -like '*\Cliplink\Trigger\CliplinkTrigger.exe')) } |
    ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
    }

# exeは自分のインストールフォルダ基準でしかrepoRootを知らない。install実行ごとに最新のパスへ更新する(冪等)。
# BOM付きUTF8で書くとNode/JSON.parse側がBOMを読み込んでしまうため、File.WriteAllText既定(BOM無し)で書く。
$configJson = @{ repoRoot = $RepoRoot } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($configPath, $configJson)

# .NET Framework csc.exeで小型winexeをビルドする。常に再ビルドして最新のコードを反映する。
$cscPath = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
if (-not (Test-Path -LiteralPath $cscPath)) { throw ".NET Framework csc.exe not found: $cscPath" }

# 直前で停止したプロセスのファイルロック解放を少し待つ(冪等な再実行での上書き失敗を防ぐ)。
for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-Path -LiteralPath $exePath)) { break }
    try { [IO.File]::OpenWrite($exePath).Close(); break } catch { Start-Sleep -Milliseconds 200 }
}

# 撮影・送信処理（windows-ondemand-capture.cs / windows-hotkey.cs）も同じEXEへ組み込み、押下のたびのPowerShell起動・コンパイルをなくす。
& $cscPath /nologo /target:winexe /platform:anycpu /optimize+ `
    /reference:System.dll,System.Windows.Forms.dll,System.Drawing.dll,System.Net.Http.dll `
    /out:$exePath $sourcePath (Join-Path $PSScriptRoot 'windows-hotkey.cs') (Join-Path $PSScriptRoot 'windows-ondemand-capture.cs')
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }

# ログイン時の自動起動用Startupショートカットを毎回作り直す(冪等)。
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $InstallDir
$shortcut.WindowStyle = 7
$shortcut.Description = 'Cliplink（ショートカットキーと通知領域アイコン）'
$shortcut.Save()

# 撮影していない時も管理画面を開けるよう、スタートメニューに「Cliplink」を置く（補助処理の Open モード）。
New-Item -ItemType Directory -Force -Path $ProgramsDir | Out-Null
$dashboardShortcut = $shell.CreateShortcut((Join-Path $ProgramsDir 'Cliplink.lnk'))
$dashboardShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$dashboardShortcut.Arguments = '-NoProfile -WindowStyle Hidden -Sta -ExecutionPolicy Bypass -File "' + (Join-Path $RepoRoot 'scripts\windows-ondemand-capture.ps1') + '" -Mode Open'
$dashboardShortcut.WorkingDirectory = $RepoRoot
$dashboardShortcut.WindowStyle = 7
$dashboardShortcut.Description = 'Cliplink の管理画面を開く'
$dashboardShortcut.Save()

if (-not $SkipLaunch) {
    $started = Start-Process -FilePath $exePath -WindowStyle Hidden -PassThru
    # 別の常駐が残っていると新しい版は即終了する。数秒後も動いているかを確かめ、黙って失敗しない。
    Start-Sleep -Seconds 3
    if ($started.HasExited) {
        throw "CliplinkTrigger.exe exited right after start. Another Cliplink trigger may still be running; sign out and in, then run this again."
    }
}

Write-Output "READY $exePath"
