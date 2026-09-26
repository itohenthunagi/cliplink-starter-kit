$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-hotkey.cs') -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')
    [System.Windows.Forms.Application]::Run([CliplinkHotkey]::new())
} catch {
    [Console]::WriteLine('ERROR helper-start-failed')
    exit 1
}
