# Download a portable Node runtime into <project>\runtime\ -- users do not have
# to install Node themselves. Nothing is written outside the project folder and
# no system PATH entry is created.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File windows\get-node.ps1
#   powershell -ExecutionPolicy Bypass -File windows\get-node.ps1 -Version v22.20.0
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 parses .ps1 files
# as ANSI/GBK unless they carry a UTF-8 BOM, which corrupts non-ASCII source.
param(
  [string]$Version = 'v24.22.0',
  [string]$Mirror  = ''
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root 'runtime'
$target  = Join-Path $runtime 'node'
$exe     = Join-Path $target 'node.exe'

if (Test-Path $exe) {
  $have = (& $exe -v) 2>$null
  if ($have -eq $Version) {
    Write-Host "==> already installed: $exe ($have)"
    exit 0
  }
}

switch ($env:PROCESSOR_ARCHITECTURE) {
  'ARM64' { $arch = 'arm64' }
  default { $arch = 'x64' }
}
$file = "node-$Version-win-$arch.zip"

$mirrors = @()
if ($Mirror) { $mirrors += $Mirror }
$mirrors += @(
  'https://nodejs.org/dist',
  'https://registry.npmmirror.com/-/binary/node',
  'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release'
)

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$tmp = Join-Path $env:TEMP ("node-dl-" + [guid]::NewGuid().ToString('N') + '.zip')

$ok = $false
foreach ($m in $mirrors) {
  $url = "$m/$Version/$file"
  Write-Host "==> downloading $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 60
    $ok = $true
    break
  } catch {
    Write-Host "    mirror failed, trying next..."
  }
}
if (-not $ok) {
  Write-Host "X all mirrors failed. Download $file manually and unzip it to $target" -ForegroundColor Red
  exit 1
}

Write-Host "==> extracting into runtime\"
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
$stage = Join-Path $runtime ("stage-" + [guid]::NewGuid().ToString('N'))
Expand-Archive -Path $tmp -DestinationPath $stage -Force
Move-Item (Join-Path $stage "node-$Version-win-$arch") $target
Remove-Item $stage -Recurse -Force
Remove-Item $tmp -Force

Write-Host ""
Write-Host ("OK  installed: " + $exe + " (" + (& $exe -v) + ")")
Write-Host "    start with: windows\start.cmd"
