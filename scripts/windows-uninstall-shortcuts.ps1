param(
    [string]$TargetDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cliplink')
)
$ErrorActionPreference = 'Stop'

foreach ($name in @('Cliplink 範囲撮影.lnk', 'Cliplink 範囲録画.lnk')) {
    $path = Join-Path $TargetDir $name
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
if ((Test-Path -LiteralPath $TargetDir) -and ((Get-ChildItem -LiteralPath $TargetDir -Force | Measure-Object).Count -eq 0)) {
    Remove-Item -LiteralPath $TargetDir -Force
}
Write-Output "REMOVED $TargetDir"
