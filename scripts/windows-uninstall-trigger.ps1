param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Cliplink\Trigger'),
    [string]$StartupDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'),
    [string]$LegacyShortcutDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cliplink'),
    [string]$ProgramsDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
$ErrorActionPreference = 'Stop'

function Get-FullDirectoryPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A target path is required.' }
    try { $fullPath = [System.IO.Path]::GetFullPath($Path) }
    catch { throw "The target path could not be resolved: $Path" }
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $pathRoot.Length) { $fullPath = $fullPath.TrimEnd('\', '/') }
    return $fullPath
}

function Test-PathSameOrBelow {
    param([string]$Path, [string]$BasePath)
    $normalizedPath = Get-FullDirectoryPath $Path
    $normalizedBase = Get-FullDirectoryPath $BasePath
    if ($normalizedPath -ieq $normalizedBase) { return $true }
    $prefix = $normalizedBase
    if (-not $prefix.EndsWith('\') -and -not $prefix.EndsWith('/')) { $prefix += [System.IO.Path]::DirectorySeparatorChar }
    return $normalizedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

$InstallDir = Get-FullDirectoryPath $InstallDir
$StartupDir = Get-FullDirectoryPath $StartupDir
$LegacyShortcutDir = Get-FullDirectoryPath $LegacyShortcutDir
$repoRoot = Get-FullDirectoryPath (Join-Path $PSScriptRoot '..')
$defaultInstallDir = Get-FullDirectoryPath (Join-Path $env:LOCALAPPDATA 'Cliplink\Trigger')
$installRoot = [System.IO.Path]::GetPathRoot($InstallDir)
$installParent = [System.IO.Path]::GetDirectoryName($InstallDir)
$ownedFileNames = @(
    'CliplinkTrigger.exe',
    'trigger-config.json',
    'trigger-status.json',
    'trigger-status.json.tmp',
    'hotkeys.json',
    'hotkeys.json.tmp'
)

# ドライブ直下・アプリ共通フォルダ・リポジトリ自身とその親を対象にしない。
$installDirContainsRepo = Test-PathSameOrBelow -Path $repoRoot -BasePath $InstallDir
if ($InstallDir.TrimEnd('\', '/') -ieq $installRoot.TrimEnd('\', '/') -or
    [string]::IsNullOrWhiteSpace($installParent) -or
    $installParent.TrimEnd('\', '/') -ieq $installRoot.TrimEnd('\', '/') -or
    $installDirContainsRepo) {
    throw "InstallDir is not a safe Cliplink Trigger target: $InstallDir"
}
foreach ($protectedPath in @(
    $env:LOCALAPPDATA,
    (Join-Path $env:LOCALAPPDATA 'Cliplink'),
    $env:APPDATA,
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    $StartupDir,
    $LegacyShortcutDir
)) {
    if (-not [string]::IsNullOrWhiteSpace($protectedPath) -and
        $InstallDir -ieq (Get-FullDirectoryPath $protectedPath)) {
        throw "InstallDir is a protected application directory: $InstallDir"
    }
}

# 既存パスだけでなく、親にあるjunction/symlinkも拒否して、意図しない場所へ到達しないようにする。
$ancestor = $InstallDir
while (-not [string]::IsNullOrWhiteSpace($ancestor)) {
    if (Test-Path -LiteralPath $ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (-not $item.PSIsContainer) { throw "InstallDir path component is not a directory: $ancestor" }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "InstallDir cannot contain a reparse point: $ancestor"
        }
    }
    $parent = [System.IO.Directory]::GetParent($ancestor)
    if ($null -eq $parent) { break }
    $ancestor = $parent.FullName
}

$exePath = Join-Path $InstallDir 'CliplinkTrigger.exe'
$shortcutPath = Join-Path $StartupDir 'Cliplink Trigger.lnk'
$installDirExists = Test-Path -LiteralPath $InstallDir -PathType Container
$hasOwnedFile = $false
if ($installDirExists) {
    foreach ($name in $ownedFileNames) {
        if (Test-Path -LiteralPath (Join-Path $InstallDir $name)) { $hasOwnedFile = $true; break }
    }
}
$isDedicatedInstallDir = $false
if ($InstallDir -ieq $defaultInstallDir) { $isDedicatedInstallDir = $true }
if ($hasOwnedFile) { $isDedicatedInstallDir = $true }

# 再実行時のInstallDir欠如は正常。既存の無関係なフォルダは何も削除せず終了する。
$isUnknownExistingInstallDir = $installDirExists -and ($isDedicatedInstallDir -eq $false)
if ($isUnknownExistingInstallDir) {
    Write-Output "SKIPPED unrelated InstallDir; left untouched: $InstallDir"
    exit 0
}

# このアプリの実行ファイルパスに完全一致するプロセスだけを止める。他プロセスには一切触れない。
if ($installDirExists -or $isDedicatedInstallDir) {
    $candidateProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'CliplinkTrigger.exe'" -ErrorAction SilentlyContinue)
    foreach ($candidateProcess in $candidateProcesses) {
        if ([string]::IsNullOrWhiteSpace($candidateProcess.ExecutablePath)) { continue }
        try { $candidateExePath = [System.IO.Path]::GetFullPath($candidateProcess.ExecutablePath) }
        catch { continue }
        if ($candidateExePath -ieq $exePath) {
            try { Stop-Process -Id $candidateProcess.ProcessId -Force -ErrorAction Stop } catch {}
        }
    }
}

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) { Remove-Item -LiteralPath $shortcutPath -Force }
$dashboardShortcutPath = Join-Path $ProgramsDir 'Cliplink.lnk'
if (Test-Path -LiteralPath $dashboardShortcutPath -PathType Leaf) { Remove-Item -LiteralPath $dashboardShortcutPath -Force }

if (Test-Path -LiteralPath $InstallDir -PathType Container) {
    # 直前で停止したプロセスのファイルロック解放を待ち、Cliplink所有の既知ファイルだけを個別に削除する。
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $InstallDirItem = Get-Item -LiteralPath $InstallDir -Force
        if (($InstallDirItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "InstallDir changed to a reparse point during uninstall: $InstallDir"
        }

        foreach ($name in $ownedFileNames) {
            $path = Join-Path $InstallDir $name
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } catch {}
            }
        }

        $remainingOwnedFiles = @()
        foreach ($name in $ownedFileNames) {
            if (Test-Path -LiteralPath (Join-Path $InstallDir $name)) { $remainingOwnedFiles += $name }
        }
        if ($remainingOwnedFiles.Count -eq 0) { break }
        if ($attempt -lt 9) { Start-Sleep -Milliseconds 200 }
    }

    $remainingOwnedFiles = @()
    foreach ($name in $ownedFileNames) {
        if (Test-Path -LiteralPath (Join-Path $InstallDir $name)) { $remainingOwnedFiles += $name }
    }
    if ($remainingOwnedFiles.Count -gt 0) {
        $remainingOwnedFileList = $remainingOwnedFiles -join ', '
        throw "Could not remove Cliplink-owned files from InstallDir: $remainingOwnedFileList"
    }

    # 無関係なファイルが残っていればInstallDirを保つ。空の場合だけ非再帰でディレクトリを消す。
    $remainingEntries = @(Get-ChildItem -LiteralPath $InstallDir -Force)
    if ($remainingEntries.Count -eq 0) {
        Remove-Item -LiteralPath $InstallDir -Force
    }
}

# 旧Start Menu .lnk方式が残っていれば既知のショートカットだけを除去する(既に撤去済みでも冪等)。
$legacyUninstall = Join-Path $PSScriptRoot 'windows-uninstall-shortcuts.ps1'
if (Test-Path -LiteralPath $legacyUninstall -PathType Leaf) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $legacyUninstall -TargetDir $LegacyShortcutDir | Out-Null
}

Write-Output "REMOVED $InstallDir"
