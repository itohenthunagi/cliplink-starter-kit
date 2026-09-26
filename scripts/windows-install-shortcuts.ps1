param(
    [string]$TargetDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cliplink'),
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)
$ErrorActionPreference = 'Stop'

function New-CliplinkShortcut {
    param(
        [string]$Path,
        [string]$Mode,
        [string]$Hotkey,
        [string]$RepoRoot
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $scriptPath = Join-Path $RepoRoot 'scripts\windows-ondemand-capture.ps1'
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -Sta -ExecutionPolicy Bypass -File `"$scriptPath`" -Mode $Mode"
    $shortcut.WorkingDirectory = $RepoRoot
    $shortcut.Hotkey = $Hotkey
    $shortcut.IconLocation = 'powershell.exe,0'
    $shortcut.Description = "Cliplink $Mode capture"
    $shortcut.Save()
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
# Start Menu / デスクトップ以外に置いたショートカットはOSがHotKeyを無効化するため、必ずStart Menu配下へ置く。
New-CliplinkShortcut -Path (Join-Path $TargetDir 'Cliplink 範囲撮影.lnk') -Mode 'Image' -Hotkey 'CTRL+ALT+S' -RepoRoot $RepoRoot
New-CliplinkShortcut -Path (Join-Path $TargetDir 'Cliplink 範囲録画.lnk') -Mode 'Video' -Hotkey 'CTRL+ALT+R' -RepoRoot $RepoRoot
Write-Output "READY $TargetDir"
