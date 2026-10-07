param(
    [ValidatePattern('^[A-Za-z0-9_-]{11}$')]
    [string[]]$VideoId = @('jNY_wLukVW0'),
    [ValidateRange(60, 3600)]
    [int]$TimeoutSeconds = 1200,
    [switch]$MseOnly
)

# Perfil y base de datos propios. No toca la biblioteca ni la instalación del usuario.
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $projectDir 'capture-bench.local'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$configPath = Join-Path $outputDir 'tauri.json'
$planPath = Join-Path $outputDir 'plan.json'
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$resultPath = Join-Path $outputDir "result-$runId.json"
$stdoutPath = Join-Path $outputDir "stdout-$runId.log"
$stderrPath = Join-Path $outputDir "stderr-$runId.log"
$config = @{
    identifier = 'dev.musify.capturetest'
    productName = 'Musify Capture Test'
    app = @{ windows = @(@{ label = 'main'; title = 'Musify Capture Test'; visible = $false }) }
    bundle = @{ active = $false; createUpdaterArtifacts = $false }
} | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
$mseFixtures = Get-Content (Join-Path $projectDir 'tests/fixtures/mse-audio.json') -Raw | ConvertFrom-Json
$plan = if ($MseOnly) {
    $mseFixtures | ConvertTo-Json -Depth 8
} else { @{
    videos = @($VideoId | ForEach-Object { @{ id = $_; label = $_; duration = 0 } })
    tier2 = @{ count = $VideoId.Count }
    audio = $true
    mse = $mseFixtures.mse
} | ConvertTo-Json -Depth 8 }
[IO.File]::WriteAllText($planPath, $plan, [Text.UTF8Encoding]::new($false))

$envKeys = @('PATH', 'MUSIFY_BENCH', 'MUSIFY_BENCH_OUT', 'MUSIFY_BENCH_EXIT', 'MUSIFY_ENGINE')
$savedEnv = @{}
foreach ($key in $envKeys) { $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$testProcess = $null
Push-Location $projectDir
try {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    $env:PATH = "$cargoBin;$env:PATH"
    & node 'node_modules/@tauri-apps/cli/tauri.js' build --debug --no-bundle --no-sign --config $configPath
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar el banco de captura.' }
    $env:MUSIFY_BENCH = $planPath
    $env:MUSIFY_BENCH_OUT = $resultPath
    $env:MUSIFY_BENCH_EXIT = '1'
    $env:MUSIFY_ENGINE = 'oficial'
    $testProcess = Start-Process -FilePath (Join-Path $projectDir 'src-tauri\target\debug\musify.exe') `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $testName = if ($MseOnly) { 'MSE con audio sintético local' } else { 'Captura oficial sin clientes API propios' }
    Write-Output "$testName. PID $($testProcess.Id); informe: $resultPath"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (!$testProcess.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        $testProcess.Refresh()
    }
    if (!$testProcess.HasExited) { throw "La prueba agotó $TimeoutSeconds segundos. Diagnóstico: $stderrPath" }
    if (!(Test-Path -LiteralPath $resultPath)) { throw "La app terminó sin informe. Diagnóstico: $stderrPath" }
    $report = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    $report | ConvertTo-Json -Depth 15
    $expected = @($report.mse).Count -eq @($mseFixtures.mse).Count
    if (!$MseOnly) { $expected = $expected -and @($report.tier2).Count -eq $VideoId.Count }
    if ($report.fatal -or !$report.ok -or !$expected) {
        throw "La captura no superó la prueba. Informe: $resultPath"
    }
} finally {
    if ($testProcess -and !$testProcess.HasExited) { Stop-Process -Id $testProcess.Id -ErrorAction SilentlyContinue }
    foreach ($key in $envKeys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
    Pop-Location
}
