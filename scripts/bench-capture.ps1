param(
    [ValidatePattern('^[A-Za-z0-9_-]{11}$')]
    [string[]]$VideoId = @('jNY_wLukVW0'),
    [ValidateRange(60, 21600)]
    [int]$TimeoutSeconds = 1200,
    [ValidateRange(15, 1200)]
    [int]$CaseTimeoutSeconds = 120,
    [switch]$MseOnly,
    [ValidateSet('smoke', 'catalog', 'album', 'switch', 'latency', 'native-search', 'ad-transitions', 'profile-login')]
    [string]$Suite = 'smoke',
    [ValidateSet('oficial', 'propio')]
    [string]$Engine = 'oficial',
    [ValidateSet('anonymous', 'premium-manual')]
    [string]$ProfileMode = 'anonymous',
    [ValidateSet('auto', 'youtube')]
    [string]$Surface = 'auto',
    [ValidateRange(0, 30)]
    [double]$HoldbackSeconds = 1.5,
    [ValidateRange(1, 3)]
    [int]$MaxSessions = 3,
    [ValidateRange(16, 4096)]
    [int]$TrackMemoryMb = 96,
    [ValidateRange(16, 4096)]
    [int]$CacheMemoryMb = 288,
    [ValidateRange(50, 200)]
    [int]$AdAttempts = 60,
    [switch]$AuditAllAudio,
    [string]$CorpusPath,
    [switch]$VerifiedOnly,
    [switch]$NoSeek,
    [switch]$NoBuild
)

# Perfil y base de datos propios. No toca la biblioteca ni la instalación del usuario.
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $projectDir 'capture-bench.local'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$configPath = Join-Path $outputDir 'tauri.json'
$binaryPath = Join-Path $projectDir 'src-tauri\target\debug\musify.exe'
$buildMarker = Join-Path $outputDir 'built-identifier.txt'
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$planPath = Join-Path $outputDir "plan-$runId.json"
$resultPath = Join-Path $outputDir "result-$runId.json"
$stdoutPath = Join-Path $outputDir "stdout-$runId.log"
$stderrPath = Join-Path $outputDir "stderr-$runId.log"
$config = @{
    identifier = 'dev.musify.captureofficialtest'
    productName = 'Musify Official Test'
    app = @{ windows = @(@{ label = 'main'; title = 'Musify Official Test'; visible = $false }) }
    bundle = @{ active = $false; createUpdaterArtifacts = $false }
} | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
$mseFixtures = Get-Content (Join-Path $projectDir 'tests/fixtures/mse-audio.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$suitePlan = @{ mode = $Suite; timeoutSeconds = $CaseTimeoutSeconds; engine = $Engine; profileMode = $ProfileMode; auditAllAudio = [bool]$AuditAllAudio }
if ($Suite -eq 'native-search') { $Engine = 'propio'; $suitePlan.engine = $Engine }
if ($Suite -eq 'profile-login') { $ProfileMode = 'premium-manual'; $suitePlan.profileMode = $ProfileMode }
if ($Suite -eq 'ad-transitions') { $suitePlan.maxAdAttempts = $AdAttempts; $suitePlan.minimumAdTransitions = 50; $suitePlan.verifyComplete = $false; $suitePlan.seek = $false }
if ($VerifiedOnly) { $suitePlan.experimental = $false; $suitePlan.seek = $false }
if ($NoSeek) { $suitePlan.seek = $false }
if ($CorpusPath) {
    $corpus = Get-Content -LiteralPath $CorpusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($corpus.captureSuite) { $corpus = $corpus.captureSuite.corpus }
    $suitePlan.corpus = $corpus
} elseif ($Suite -eq 'smoke' -or ($Suite -eq 'latency' -and $PSBoundParameters.ContainsKey('VideoId'))) {
    $suitePlan.videos = @($VideoId | ForEach-Object { @{ id = $_; label = $_; duration = 0 } })
}
$plan = if ($MseOnly) {
    $mseFixtures | Add-Member -NotePropertyName rates -NotePropertyValue $true -Force
    $mseFixtures | ConvertTo-Json -Depth 8
} else { @{
    videos = @()
    captureSuite = $suitePlan
} | ConvertTo-Json -Depth 20 }
[IO.File]::WriteAllText($planPath, $plan, [Text.UTF8Encoding]::new($false))

$envKeys = @('PATH', 'MUSIFY_BENCH', 'MUSIFY_BENCH_PROGRESSIVE', 'MUSIFY_BENCH_OUT', 'MUSIFY_BENCH_EXIT', 'MUSIFY_ENGINE', 'MUSIFY_BENCH_PROFILE_MODE', 'MUSIFY_BENCH_SURFACE', 'MUSIFY_BENCH_HOLDBACK_SECONDS', 'MUSIFY_CAPTURE_MAX_SESSIONS', 'MUSIFY_CAPTURE_TRACK_MB', 'MUSIFY_CAPTURE_CACHE_MB', 'MUSIFY_BENCH_AUDIT_ALL_AUDIO')
$savedEnv = @{}
foreach ($key in $envKeys) { $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$testProcess = $null
Push-Location $projectDir
try {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    $env:PATH = "$cargoBin;$env:PATH"
    if (!$NoBuild) {
        & node 'node_modules/@tauri-apps/cli/tauri.js' build --debug --no-bundle --no-sign --config $configPath
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar el banco de captura.' }
        [IO.File]::WriteAllText($buildMarker, (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash)
    } elseif (!(Test-Path -LiteralPath $buildMarker) -or (Get-Content -LiteralPath $buildMarker -Raw) -ne (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash) {
        throw 'NoBuild requiere el mismo binario aislado que compiló este banco.'
    }
    $env:MUSIFY_BENCH = $planPath
    # Experimento explícito: el marcador tardío de anuncios impide promoverlo a producción.
    $env:MUSIFY_BENCH_PROGRESSIVE = if ($VerifiedOnly) { $null } else { '1' }
    $env:MUSIFY_BENCH_OUT = $resultPath
    $env:MUSIFY_BENCH_EXIT = '1'
    $env:MUSIFY_ENGINE = $Engine
    $env:MUSIFY_BENCH_PROFILE_MODE = $ProfileMode
    $env:MUSIFY_BENCH_SURFACE = if ($Surface -eq 'youtube') { 'youtube' } else { $null }
    $env:MUSIFY_BENCH_HOLDBACK_SECONDS = $HoldbackSeconds.ToString([Globalization.CultureInfo]::InvariantCulture)
    $env:MUSIFY_CAPTURE_MAX_SESSIONS = "$MaxSessions"
    $env:MUSIFY_CAPTURE_TRACK_MB = "$TrackMemoryMb"
    $env:MUSIFY_CAPTURE_CACHE_MB = "$CacheMemoryMb"
    $env:MUSIFY_BENCH_AUDIT_ALL_AUDIO = if ($AuditAllAudio) { '1' } else { $null }
    $metadata = [ordered]@{
        startedAt = (Get-Date).ToString('o')
        branch = (& git branch --show-current)
        commit = (& git rev-parse HEAD)
        changes = @(& git status --porcelain)
        binarySha256 = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash
        identifier = 'dev.musify.captureofficialtest'
        suite = if ($MseOnly) { 'mse-and-rates' } else { $Suite }
        engine = $Engine
        profileMode = $ProfileMode
        captureSurface = $Surface
        holdbackSeconds = $HoldbackSeconds
        rawAudioProbe = [bool]$AuditAllAudio
        limits = @{ maxSessions = $MaxSessions; trackMemoryMb = $TrackMemoryMb; cacheMemoryMb = $CacheMemoryMb }
        progressiveExperiment = !$VerifiedOnly
        seekExperiment = !$VerifiedOnly -and !$NoSeek -and $Suite -ne 'ad-transitions'
        plan = $planPath
        report = $resultPath
    } | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $outputDir "metadata-$runId.json"), $metadata, [Text.UTF8Encoding]::new($false))
    $testProcess = Start-Process -FilePath $binaryPath `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $testName = if ($MseOnly) { 'MSE con audio sintético local' } elseif ($Suite -eq 'profile-login') { 'Perfil Premium para acceso manual' } else { "Banco $Suite / $Engine / $ProfileMode" }
    Write-Output "$testName. PID $($testProcess.Id); informe: $resultPath"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (!$testProcess.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        $testProcess.Refresh()
    }
    if (!$testProcess.HasExited) { throw "La prueba agotó $TimeoutSeconds segundos. Diagnóstico: $stderrPath" }
    if (!(Test-Path -LiteralPath $resultPath)) { throw "La app terminó sin informe. Diagnóstico: $stderrPath" }
    $report = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Output ($report | Select-Object ok, fatal, startedAt | ConvertTo-Json)
    if ($report.captureSuite) {
        Write-Output ($report.captureSuite.rows | Select-Object label, ok, firstSoundMs, nextTrackMs, seekMs, adsSeen, adsDelivered, failures | ConvertTo-Json -Depth 5)
    }
    $expected = if ($MseOnly) { @($report.mse).Count -eq @($mseFixtures.mse).Count } else { $report.captureSuite -and !$report.captureSuite.running }
    if ($report.fatal -or !$report.ok -or !$expected) {
        throw "La captura no superó la prueba. Informe: $resultPath"
    }
} finally {
    if ($testProcess -and !$testProcess.HasExited) { Stop-Process -Id $testProcess.Id -ErrorAction SilentlyContinue }
    foreach ($key in $envKeys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
    Pop-Location
}
