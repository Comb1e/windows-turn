param([switch]$Fusion)
$ErrorActionPreference = 'Stop'
$rendererExecutable = Join-Path $PSScriptRoot 'build/Release/HingeGlass.exe'
if (-not (Test-Path -LiteralPath $rendererExecutable)) {
    & (Join-Path $PSScriptRoot 'build.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
# This is the interactive application the user explicitly launches.
if ($Fusion) { Start-Process -FilePath $rendererExecutable -ArgumentList '--fusion' }
else { Start-Process -FilePath $rendererExecutable }
