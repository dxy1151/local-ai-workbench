# Build the transfer zip.
#   - version is read from package.json, output is <folder>-v<version>[-dev].zip
#   - data/ is excluded (never ship the API key), zip entries use forward slashes
#   - runtime/ (portable Node) is NEVER shipped in the package
#
# IMPORTANT: entry names MUST use forward slashes. PowerShell's Compress-Archive
# writes backslashes (workbench\lib\server.js), which Android's unzip cannot
# handle -- it silently fails to create directories. Do not change this back.
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 parses .ps1 files
# as ANSI/GBK unless they carry a UTF-8 BOM, which corrupts non-ASCII source.
#
# Usage:
#   pwsh -File build.ps1              # dev bundle (keeps smoke.js etc.)
#   pwsh -File build.ps1 -Release     # release bundle (drops test files)
param([switch]$Release)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$root = $PSScriptRoot
$name = Split-Path $root -Leaf
$jsonPath = Join-Path $root 'package.json'

# Read package.json as explicit UTF-8; PS 5.1's Get-Content would use ANSI/GBK.
$pkgText = [System.IO.File]::ReadAllText($jsonPath, [System.Text.UTF8Encoding]::new($false))
$version = ($pkgText | ConvertFrom-Json).version
$suffix = if ($Release) { '' } else { '-dev' }
$out = Join-Path (Split-Path $root -Parent) "$name-v$version$suffix.zip"

# data-dir.txt is device-specific (it holds an absolute path for THIS machine),
# so it must never ship in the package -- devices get data-dir.txt.example instead.
# runtime/ holds the portable Node runtime and can be tens of MB.
$exclude = @('data', 'node_modules', 'data-smoke', 'data-dir.txt', '.tts-cache', '.gitignore', 'runtime')
if ($Release) { $exclude += @('smoke.js', 'smoke-env.js') }
if (Test-Path $out) { Remove-Item $out -Force }

$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  Get-ChildItem -Path $root -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1)
    if ($exclude -contains $rel.Split('\')[0]) { return }
    if ($rel -like '*.zip') { return }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $_.FullName, "$name/$($rel -replace '\\','/')") | Out-Null
  }
} finally { $zip.Dispose() }

# Self-check so a broken package never reaches the phone.
$check = [System.IO.Compression.ZipFile]::OpenRead($out)
$bad = ($check.Entries | Where-Object { $_.FullName -like '*\*' }).Count
$leak = ($check.Entries | Where-Object { $_.FullName -like "$name/data/*" }).Count
$runtime = ($check.Entries | Where-Object { $_.FullName -like "$name/runtime/*" }).Count
$smoke = ($check.Entries | Where-Object { $_.FullName -eq "$name/smoke.js" }).Count
$count = $check.Entries.Count
$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
$check.Dispose()

Write-Host ""
Write-Host "  output   : $out"
Write-Host "  mode     : $(if ($Release) { 'release' } else { 'dev' })"
Write-Host "  version  : v$version"
Write-Host "  files    : $count"
Write-Host "  size     : $size KB"
Write-Host "  backslash: $bad $(if ($bad -eq 0) { 'OK' } else { 'FAIL - unzip will break' })"
Write-Host "  data leak: $leak $(if ($leak -eq 0) { 'OK (no API key)' } else { 'FAIL - API key leaked' })"
Write-Host "  runtime  : $runtime $(if ($runtime -eq 0) { 'OK (not bundled)' } else { 'FAIL - portable node shipped' })"
Write-Host "  smoke.js : $smoke $(if ($Release) { '(release: should be 0)' } else { '(dev: should be 1)' })"
Write-Host ""

if ($bad -ne 0 -or $leak -ne 0 -or $runtime -ne 0) { exit 1 }
if ($Release -and $smoke -ne 0) { exit 1 }
