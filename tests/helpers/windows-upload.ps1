$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\..\scripts\windows-hotkey.cs') -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')
$png = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
$status = [CliplinkUpload]::SendAsync($env:CLIPLINK_TEST_ORIGIN, $env:CLIPLINK_TEST_TOKEN, $png).GetAwaiter().GetResult()
if ($status -ne 201) { throw "Upload returned HTTP $status" }
$mp4 = [byte[]](0,0,0,24,102,116,121,112,109,112,52,50,0,0,0,0)
$status = [CliplinkUpload]::SendFileAsync($env:CLIPLINK_TEST_ORIGIN, $env:CLIPLINK_TEST_TOKEN, $mp4, 'recording.mp4', '範囲録画').GetAwaiter().GetResult()
if ($status -ne 201) { throw "Video upload returned HTTP $status" }
