param(
    [ValidateSet(60, 120, 240)][int]$Fps = 60,
    [switch]$Live,
    [ValidateSet('physical', 'rotation')][string]$Projection = 'physical',
    [ValidateRange(1,120)][int]$Seconds = 60
)
$ErrorActionPreference = 'Stop'
$rendererExecutable = Join-Path $PSScriptRoot 'build/Release/HingeGlass.exe'
if (-not (Test-Path -LiteralPath $rendererExecutable)) { throw 'Run renderer/build.ps1 first.' }
$kind = if ($Live) { 'live' } else { 'synthetic' }
$report = Join-Path $PSScriptRoot "out/$kind-$Fps.json"
$arguments = @('--benchmark', '--overlay', '--no-preferences', '--fps', $Fps, '--projection', $Projection, '--seconds', $Seconds, '--report', ('"' + $report + '"'))
if (-not $Live) { $arguments += '--synthetic' }
$process = Start-Process -FilePath $rendererExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "Renderer exited with code $($process.ExitCode). Check $report" }
Get-Content -LiteralPath $report
