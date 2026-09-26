param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Image', 'Video', 'Open')]
    [string]$Mode
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
try {
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'windows-hotkey.cs'),
        (Join-Path $PSScriptRoot 'windows-ondemand-capture.cs')
    ) -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')
    $code = [CliplinkOnDemandCapture]::RunAsync($Mode, $repoRoot).GetAwaiter().GetResult()
    exit $code
} catch {
    [Console]::WriteLine('ERROR helper-start-failed')
    exit 1
}
