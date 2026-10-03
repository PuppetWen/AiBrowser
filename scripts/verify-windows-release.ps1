param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$PackageRoot,
  [string]$ZipPath = '',
  [string]$Version = '1.0.9'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sourceDirectory = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
$stageDirectory = (Resolve-Path -LiteralPath $PackageRoot).ProviderPath
$projectDirectory = Split-Path -Parent $sourceDirectory
$paths = @('package.json', 'main.js', 'engine.js', 'cdp.js', 'renderer.js', 'preload.js', 'index.html',
  'automation/privacy-policy.js', 'automation/privacy-gateway.js', 'automation/privacy-firewall.js',
  'automation/fingerprint.js', 'automation/start-page-server.js', 'automation/external-kernel.js',
  'automation/mihomo-manager.js', 'scripts/privacy-firewall.ps1')
$expectedFiles = @($paths | ForEach-Object { @{ relative = 'resources/app/' + $_; source = Join-Path $sourceDirectory $_ } })
foreach ($name in @('README.md', 'README.zh-CN.md')) { $expectedFiles += @{ relative = $name; source = Join-Path $projectDirectory $name } }
$expectedFiles += @{ relative = 'RELEASE-NOTES.md'; source = Join-Path $projectDirectory ('docs/releases/v' + $Version + '.md') }

function Get-StreamHash([IO.Stream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-FileHashValue([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  try { return Get-StreamHash $stream } finally { $stream.Dispose() }
}
$stageManifest = Get-Content -LiteralPath (Join-Path $stageDirectory 'resources/app/package.json') -Raw | ConvertFrom-Json
if ($stageManifest.version -ne $Version) { throw 'Staged application version mismatch' }
$mainExe = Join-Path $stageDirectory 'AiBrowser.exe'
$mainInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($mainExe)
if ($mainInfo.FileVersion -ne ($Version + '.0') -or $mainInfo.ProductVersion -ne ($Version + '.0')) { throw 'Staged executable metadata mismatch' }
$expectedFiles += @{ relative = 'AiBrowser.exe'; source = $mainExe }
$stageFiles = @(Get-ChildItem -LiteralPath $stageDirectory -Recurse -File -Force)
foreach ($file in $stageFiles) {
  $relative = $file.FullName.Substring($stageDirectory.Length + 1).Replace('\', '/')
  if ($relative -match '(^|/)(browser-data|rpa-output|\.cache)(/|$)|(^|/)\.env($|\.)|\.(accounts\.csv|credentials\.json|secrets\.json)$|(^|/)(Cookies|Login Data|History|Local State|user\.js|prefs\.js|sessionstore\.jsonlz4)$') { throw ('Private artifact in staging: ' + $relative) }
}
$verified = @()
foreach ($file in $expectedFiles) {
  $file.hash = Get-FileHashValue $file.source
  $stagedFile = Join-Path $stageDirectory $file.relative
  if (-not (Test-Path -LiteralPath $stagedFile -PathType Leaf) -or (Get-FileHashValue $stagedFile) -ne $file.hash) { throw ('Missing or outdated staged file: ' + $file.relative) }
  $verified += @{ file = $file.relative; sha256 = $file.hash }
}
if ($ZipPath) {
  $resolvedZip = (Resolve-Path -LiteralPath $ZipPath).ProviderPath
  $archive = [IO.Compression.ZipFile]::OpenRead($resolvedZip)
  try {
    $prefix = (Split-Path -Leaf $stageDirectory) + '/'
    $entries = @{}
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if ($name -match '(^|/)(browser-data|rpa-output|\.cache)(/|$)|(^|/)\.env($|\.)|\.(accounts\.csv|credentials\.json|secrets\.json)$|(^|/)(Cookies|Login Data|History|Local State|user\.js|prefs\.js|sessionstore\.jsonlz4)$') { throw ('Private artifact in ZIP: ' + $name) }
      if ($entries.ContainsKey($name)) { throw ('Duplicate ZIP entry: ' + $name) }
      $entries[$name] = $entry
    }
    foreach ($file in $expectedFiles) {
      $name = $prefix + $file.relative
      $entry = $entries[$name]
      if (-not $entry) { throw ('Missing ZIP entry: ' + $name) }
      $stream = $entry.Open()
      try { if ((Get-StreamHash $stream) -ne $file.hash) { throw ('Outdated ZIP entry: ' + $name) } }
      finally { $stream.Dispose() }
    }
  } finally { $archive.Dispose() }
}
@{ version = $Version; stagedFiles = $stageFiles.Count; verified = $verified; zipVerified = [bool]$ZipPath; privateDataFiles = 0; mode = 'read-only staged and ZIP hashes; no executable run' } | ConvertTo-Json -Depth 5 -Compress
