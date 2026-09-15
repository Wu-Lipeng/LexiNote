param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'addon\manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$package = Join-Path $destination ('lexinote-' + $manifest.version + '.xpi')
if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package }
[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $PSScriptRoot 'addon'), $package)
Write-Output $package
