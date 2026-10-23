$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$manifest = Get-Content -LiteralPath (Join-Path $root 'UPSTREAM-PROVENANCE.json') -Raw | ConvertFrom-Json
if ($manifest.schema -ne 'vendored-crate-provenance-v1' -or $manifest.originalFiles.Count -ne 306) {
    throw 'Unexpected upstream inventory.'
}
$expected = @{}
foreach ($entry in $manifest.originalFiles) { $expected[$entry.path] = $entry.sha256 }
foreach ($entry in $manifest.localChanges) {
    if (!$expected.ContainsKey($entry.path)) { throw 'Patch names a non-upstream file.' }
    $expected[$entry.path] = $entry.sha256
}
if ($manifest.localChanges.Count -ne 2) { throw 'Expected exactly two patched upstream files.' }
foreach ($entry in $expected.GetEnumerator()) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $entry.Key))
    if (!$path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Invalid inventory path.'
    }
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing vendored file: $($entry.Key)" }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
        throw "Vendored checksum mismatch: $($entry.Key)"
    }
}
Write-Output "Verified $($expected.Count) upstream files, including two documented patches."
