param([switch]$Test)
$ErrorActionPreference = 'Stop'
$rendererRoot = $PSScriptRoot
$buildPath = Join-Path $rendererRoot 'build'
cmake -S $rendererRoot -B $buildPath -G 'Visual Studio 17 2022' -A x64 '-DCMAKE_SYSTEM_VERSION=10.0.26100.0'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cmake --build $buildPath --config Release --parallel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Test) {
    ctest --test-dir $buildPath -C Release --output-on-failure
    exit $LASTEXITCODE
}
