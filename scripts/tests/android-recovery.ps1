<#
Build and run the repository's recovery regressions with real Media3 and a supplied ARM64 JNI APK.
No Rust rebuild or release signing is needed. Only dev.musify.desktop.autotest is installed.
The test host is not the Tauri UI; it allows loopback HTTP, mutes PCM, and requires ARM64 or
an emulator with ARM translation. Run network-return tests only on a dedicated emulator:
they disable/re-enable Wi-Fi and mobile data. No AVD is started or stopped by this script.

Example (PowerShell, Java 21 and Gradle 9.6.1):
  ./scripts/tests/android-recovery.ps1 -PublishedApk <release.apk> -OutputRoot <scratch-directory> `
    -SdkRoot <android-sdk> -Gradle <gradle.bat> -Serial emulator-5580
Use -BuildOnly to compile the APKs and run the JVM policy tests without touching a device.
Evidence contains source/APK hashes, build/JUnit logs and per-method HTTP/player reports.
#>
param(
  [Parameter(Mandatory)][string]$PublishedApk,
  [Parameter(Mandatory)][string]$OutputRoot,
  [string]$SdkRoot = $env:ANDROID_HOME,
  [string]$Gradle = 'gradle',
  [string]$Serial = 'emulator-5580',
  [switch]$BuildOnly,
  [string[]]$Methods = @(
    'pendingHttpRetryMustRespectPause',
    'retryFromPreviousTrackMustNotResumeNewPausedTrack',
    'stopDuringHttpRetryStaysStopped',
    'fourSeparatedHttpFailuresMustNotSkipRecoveredTrack',
    'validatedNetworkReturnPreservesPause',
    'validatedNetworkReturnResumesSameTrack',
    'retryCancellationRaces20Times'
  )
)
$ErrorActionPreference = 'Stop'
$productRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$auditRoot = [IO.Path]::GetFullPath($OutputRoot)
if ($auditRoot.StartsWith($productRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $auditRoot -eq $productRoot) { throw 'OutputRoot must be outside the product repository.' }
if (!$BuildOnly -and $Serial -notmatch '^emulator-\d+$') { throw 'Network fixtures require a dedicated emulator; do not run on a physical/user device.' }
if (!$BuildOnly -and $Serial -eq 'emulator-5554') { throw 'Refusing the default/user emulator. Use a dedicated test AVD.' }
$PublishedApk = (Resolve-Path -LiteralPath $PublishedApk).Path
if (!(Test-Path -LiteralPath (Join-Path $SdkRoot 'platform-tools\adb.exe'))) { throw 'Supply a valid Android SDK directory.' }
$env:ANDROID_HOME = $SdkRoot
$projectRoot = Join-Path $auditRoot 'instrumented'
$mainSource = Join-Path $projectRoot 'app\src\main\java\dev\musify\desktop'
$testSource = Join-Path $projectRoot 'app\src\androidTest\java\dev\musify\desktop'
$jni = Join-Path $projectRoot 'app\src\main\jniLibs\arm64-v8a'
New-Item -ItemType Directory -Force -Path $mainSource,$testSource,$jni | Out-Null
$manifest = @()
foreach ($name in @('PlaybackService.kt','PlaybackRecovery.kt','CarLibrary.kt','MusifyCore.kt','MusifyLog.kt','MusifyApp.kt','DownloadService.kt')) {
  $source = Join-Path $productRoot "src-tauri\gen\android\app\src\main\java\dev\musify\desktop\$name"
  Copy-Item -LiteralPath $source -Destination (Join-Path $mainSource $name)
  $manifest += [pscustomobject]@{file=$name;source=$source;sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash}
}
foreach ($name in @('CarLibraryServiceTest.kt','CarLibraryTest.kt','CarPlaybackTest.kt','PlaybackRecoveryHttpTest.kt')) {
  Copy-Item -LiteralPath (Join-Path $productRoot "src-tauri\gen\android\app\src\androidTest\java\dev\musify\desktop\$name") -Destination (Join-Path $testSource $name)
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($PublishedApk)
try { [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry('lib/arm64-v8a/libmusify_lib.so'), (Join-Path $jni 'libmusify_lib.so'), $true) } finally { $zip.Dispose() }
$manifest += [pscustomobject]@{file='libmusify_lib.so';source=$PublishedApk;sha256=(Get-FileHash -LiteralPath (Join-Path $jni 'libmusify_lib.so') -Algorithm SHA256).Hash}
$manifest | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $auditRoot 'product-source-manifest.json')
Copy-Item -LiteralPath (Join-Path $productRoot 'src-tauri\gen\android\app\src\debug\java\dev\musify\desktop\PlaybackTestActivity.kt') -Destination $mainSource
$unitSource = Join-Path $projectRoot 'app\src\test\java\dev\musify\desktop'
New-Item -ItemType Directory -Force -Path $unitSource | Out-Null
Copy-Item -LiteralPath (Join-Path $productRoot 'src-tauri\gen\android\app\src\test\java\dev\musify\desktop\PlaybackRecoveryTest.kt') -Destination $unitSource
@'
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = 'PletinaStabilityAudit'
include ':app'
'@ | Set-Content -Encoding utf8 -LiteralPath (Join-Path $projectRoot 'settings.gradle')
@'
plugins {
  id 'com.android.application' version '9.3.1' apply false
  id 'org.jetbrains.kotlin.android' version '2.2.10' apply false
}
'@ | Set-Content -Encoding utf8 -LiteralPath (Join-Path $projectRoot 'build.gradle')
@'
org.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8
org.gradle.workers.max=1
org.gradle.parallel=false
android.builtInKotlin=false
android.newDsl=false
kotlin.compiler.execution.strategy=in-process
android.useAndroidX=true
'@ | Set-Content -Encoding utf8 -LiteralPath (Join-Path $projectRoot 'gradle.properties')
@'
plugins { id 'com.android.application'; id 'org.jetbrains.kotlin.android' }
android {
  namespace 'dev.musify.desktop'
  compileSdk 37
  defaultConfig {
    applicationId 'dev.musify.desktop.autotest'
    minSdk 24
    targetSdk 37
    versionCode 10000
    versionName '0.10.0-audit'
    testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner'
    ndk { abiFilters 'arm64-v8a' }
  }
  compileOptions { sourceCompatibility JavaVersion.VERSION_1_8; targetCompatibility JavaVersion.VERSION_1_8 }
  kotlinOptions { jvmTarget = '1.8' }
  packaging { jniLibs { useLegacyPackaging = false } }
}
dependencies {
  implementation 'androidx.core:core-ktx:1.17.0'
  implementation 'androidx.media3:media3-exoplayer:1.11.1'
  implementation 'androidx.media3:media3-session:1.11.1'
  testImplementation 'junit:junit:4.13.2'
  androidTestImplementation 'androidx.test.ext:junit:1.1.4'
  androidTestImplementation 'androidx.test.espresso:espresso-core:3.5.0'
}
'@ | Set-Content -Encoding utf8 -LiteralPath (Join-Path $projectRoot 'app\build.gradle')
@'
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
 <uses-permission android:name="android.permission.INTERNET"/>
 <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
 <uses-permission android:name="android.permission.WAKE_LOCK"/>
 <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
 <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>
 <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>
 <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
 <application android:name="dev.musify.desktop.MusifyApp" android:label="Pletina isolated audit" android:usesCleartextTraffic="true" android:extractNativeLibs="false">
  <activity android:name="dev.musify.desktop.PlaybackTestActivity" android:exported="false"/>
  <service android:name="dev.musify.desktop.PlaybackService" android:foregroundServiceType="mediaPlayback" android:exported="true">
   <intent-filter><action android:name="androidx.media3.session.MediaSessionService"/><action android:name="androidx.media3.session.MediaLibraryService"/><action android:name="android.media.browse.MediaBrowserService"/></intent-filter>
  </service>
  <service android:name="dev.musify.desktop.DownloadService" android:foregroundServiceType="dataSync" android:exported="false"/>
 </application>
</manifest>
'@ | Set-Content -Encoding utf8 -LiteralPath (Join-Path $projectRoot 'app\src\main\AndroidManifest.xml')
Write-Output "Prepared $projectRoot; product Kotlin copied unchanged and published Rust library reused. Test manifest allows loopback HTTP and excludes Tauri UI; record those limits."


$apkHash = (Get-FileHash -LiteralPath $PublishedApk -Algorithm SHA256).Hash
[pscustomobject]@{apk=$PublishedApk;sha256=$apkHash;serial=$Serial;isolatedPackage='dev.musify.desktop.autotest';sourceRoot=$productRoot;note='Published Rust JNI, current repository Kotlin; loopback HTTP allowed only in test host; audio muted.'} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $auditRoot 'environment.json')
& $Gradle --no-daemon --max-workers=1 -p $projectRoot testDebugUnitTest assembleDebug assembleDebugAndroidTest 2>&1 | Tee-Object -FilePath (Join-Path $auditRoot 'build.log')
if ($LASTEXITCODE -ne 0) { throw 'Android regression build/JVM tests failed.' }
if ($BuildOnly) { return }
$adbAudit = Join-Path $SdkRoot 'platform-tools\adb.exe'
& $adbAudit -s $Serial install -r (Join-Path $projectRoot 'app\build\outputs\apk\debug\app-debug.apk')
if ($LASTEXITCODE -ne 0) { throw 'Test host install failed.' }
& $adbAudit -s $Serial install -r (Join-Path $projectRoot 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk')
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation install failed.' }
$results = @()
foreach ($method in $Methods) {
  if ($method -notmatch '^[A-Za-z][A-Za-z0-9]+$') { throw "Invalid method: $method" }
  & $adbAudit -s $Serial shell am force-stop dev.musify.desktop.autotest
  & $adbAudit -s $Serial logcat -c
  $log = Join-Path $auditRoot "instrumentation-$method.log"
  & $adbAudit -s $Serial shell am instrument -w -r -e class "dev.musify.desktop.PlaybackRecoveryHttpTest#$method" dev.musify.desktop.autotest.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | Tee-Object -FilePath $log
  $passed = (Get-Content -Raw -LiteralPath $log) -match 'OK \(1 test\)'
  $evidence = Join-Path $auditRoot "reports\$method"
  New-Item -ItemType Directory -Force -Path $evidence | Out-Null
  & $adbAudit -s $Serial logcat -d | Set-Content -Encoding utf8 -LiteralPath (Join-Path $evidence 'logcat.log')
  $files = & $adbAudit -s $Serial shell run-as dev.musify.desktop.autotest find files/audit -maxdepth 1 -type f
  foreach ($file in $files) {
    $name = [IO.Path]::GetFileName($file.Trim())
    if ($name -match '^[a-z0-9-]+\.json$') {
      & $adbAudit -s $Serial shell run-as dev.musify.desktop.autotest cat $file.Trim() | Set-Content -Encoding utf8 -LiteralPath (Join-Path $evidence $name)
    }
  }
  $results += [pscustomobject]@{method=$method;passed=$passed;log=$log;evidence=$evidence}
  $results | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $auditRoot 'results.json')
}
& $adbAudit -s $Serial shell am force-stop dev.musify.desktop.autotest
if ($results.Where({!$_.passed}).Count -gt 0) { throw 'Android recovery regression(s) failed; see results.json.' }
