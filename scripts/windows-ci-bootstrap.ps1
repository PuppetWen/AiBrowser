param(
  [Parameter(Mandatory=$true)][ValidateSet('Bootstrap', 'Build', 'Upload')][string]$Phase,
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$ReleaseTag,
  [Parameter(Mandatory=$true)][string]$SourceCommit
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$utf8 = [Text.UTF8Encoding]::new($false)
$repository = 'PuppetWen/AiBrowser'
$allowedTag = 'v1.0.9'
$allowedCommit = '721844ce9ad479ccf4fb29820df74583b5b63265'
$bootstrapUrl = 'https://github.com/PuppetWen/AiBrowser/releases/download/v1.0.8/AiBrowser-Windows-x86_64-with-kernel.zip'
$bootstrapSha256 = '1fadd3bed3cb8517d16f40e99d85605ac563bddb94bece05f842959b6c2e5930'
$bootstrapBytes = 1466667322
$nsisSha256 = '56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f'
$stem = 'AiBrowser-Windows-x86_64-with-kernel'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -cne $repository) { throw 'This script only runs in the controlled GitHub Actions repository' }
if ($ReleaseTag -cne $allowedTag -or $SourceCommit -cne $allowedCommit -or $SourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'Release tag or source commit is outside the controlled release' }
$projectDirectory = (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath
$expectedProject = [IO.Path]::GetFullPath((Join-Path $env:GITHUB_WORKSPACE 'source'))
if (-not $projectDirectory.Equals($expectedProject, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe product checkout directory' }
$version = $ReleaseTag.Substring(1)
$appDirectory = Join-Path $projectDirectory 'Browserapp'
$cacheDirectory = Join-Path $projectDirectory ('.cache/ci-release-' + $ReleaseTag)
$distDirectory = Join-Path $appDirectory ('dist/release-' + $ReleaseTag)
$packageDirectory = Join-Path $distDirectory $stem
$manifestPath = Join-Path $cacheDirectory 'build-manifest.json'
New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw ($Command + ' failed with exit code ' + $LASTEXITCODE) }
}
function Get-CheckedOutput([string]$Command, [string[]]$Arguments) {
  $result = & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw ($Command + ' failed with exit code ' + $LASTEXITCODE) }
  return ($result -join "`n").Trim()
}
function Assert-Source {
  $headCommit = Get-CheckedOutput 'git' @('-C', $projectDirectory, 'rev-parse', 'HEAD')
  $tagCommit = Get-CheckedOutput 'git' @('-C', $projectDirectory, 'rev-parse', '--verify', ($ReleaseTag + '^{commit}'))
  if ($headCommit -cne $SourceCommit -or $tagCommit -cne $SourceCommit) { throw 'Product HEAD and release tag must resolve to the exact input commit' }
  $package = Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw | ConvertFrom-Json
  $lock = Get-Content -LiteralPath (Join-Path $appDirectory 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
  if ($package.version -cne $version -or $lock['version'] -cne $version -or $lock['packages']['']['version'] -cne $version) { throw 'Source package and lockfile versions must match the release tag' }
  if ($package.devDependencies.'desktop-shell' -cne 'npm:electron@43.1.1' -or $lock['packages']['node_modules/desktop-shell']['version'] -cne '43.1.1') { throw 'Unexpected desktop runtime version' }
  $changes = Get-CheckedOutput 'git' @('-C', $projectDirectory, 'status', '--porcelain', '--untracked-files=no')
  if ($changes) { throw 'Tracked product source changed during CI' }
}
function Assert-Draft {
  $release = (Get-CheckedOutput 'gh' @('api', ('repos/' + $repository + '/releases/402323423'))) | ConvertFrom-Json
  if (-not $release.draft -or $release.id -ne 402323423 -or $release.tag_name -cne $allowedTag -or $release.target_commitish -cne $allowedCommit) { throw 'Target must remain the exact existing v1.0.9 draft and source commit; published or unrelated releases are never changed' }
  return $release
}
function Assert-SafeMember([string]$Name, [long]$Attributes) {
  $member = $Name.Replace('\', '/')
  if (-not $member -or $member.StartsWith('/') -or $member.Contains([char]0) -or $member.Contains(':')) { throw 'Unsafe bootstrap ZIP path' }
  foreach ($part in $member.Split('/')) {
    if ($part -eq '..' -or $part -eq '.' -or $part -match '[. ]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Unsafe bootstrap ZIP path segment' }
  }
  if (($Attributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'Bootstrap ZIP contains a symlink' }
  return $member
}
function Copy-ZipMember($Entry, [string]$Destination, [string]$Boundary) {
  $resolvedTarget = [IO.Path]::GetFullPath($Destination)
  $resolvedBoundary = [IO.Path]::GetFullPath($Boundary).TrimEnd('\') + '\'
  if (-not $resolvedTarget.StartsWith($resolvedBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap target escaped its owned directory' }
  if (Test-Path -LiteralPath $resolvedTarget) { throw ('Bootstrap target unexpectedly exists: ' + $resolvedTarget) }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolvedTarget)) | Out-Null
  $inputStream = $Entry.Open()
  try {
    $outputStream = [IO.File]::Open($resolvedTarget, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
  } finally { $inputStream.Dispose() }
}
function Read-ZipText($Entry) {
  if (-not $Entry -or $Entry.Length -gt 1048576) { return '' }
  $reader = [IO.StreamReader]::new($Entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Configure-BuildEnvironment {
  $env:NPM_CONFIG_CACHE = Join-Path $cacheDirectory 'npm'
  $env:ELECTRON_CACHE = Join-Path $cacheDirectory 'electron'
  $env:TEMP = Join-Path $cacheDirectory 'temp'
  $env:TMP = $env:TEMP
  $env:OPENBROWSER_PACKAGE_TEMP = $env:TEMP
  $env:AIBROWSER_TEST_TMP = Join-Path $cacheDirectory 'tests'
  $env:OPENBROWSER_PACKAGE_OUTPUT = $distDirectory
  $env:OPENBROWSER_PACKAGE_VARIANT = 'with-kernel'
  $env:OPENBROWSER_PACKAGE_ARCH = 'x86_64'
  foreach ($directory in @($env:NPM_CONFIG_CACHE, $env:ELECTRON_CACHE, $env:TEMP, $env:AIBROWSER_TEST_TMP)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
}
function Select-LocalNode {
  $candidates = @()
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $candidates += $found.Source }
  if ($env:RUNNER_TOOL_CACHE) {
    $nodeCache = Join-Path $env:RUNNER_TOOL_CACHE 'node'
    if (Test-Path -LiteralPath $nodeCache -PathType Container) { $candidates += @(Get-ChildItem -LiteralPath $nodeCache -Filter node.exe -File -Recurse | Sort-Object FullName -Descending | ForEach-Object { $_.FullName }) }
  }
  foreach ($candidate in $candidates) {
    $nodeVersion = [version](Get-CheckedOutput $candidate @('-p', 'process.versions.node'))
    if ($nodeVersion -ge [version]'22.12.0') {
      $env:PATH = (Split-Path -Parent $candidate) + ';' + $env:PATH
      Write-Host ('Using existing Node ' + $nodeVersion + ': ' + $candidate)
      return
    }
  }
  throw 'No existing Node.js 22.12 or newer was found on the runner'
}
function Resolve-Nsis {
  $candidates = @((Join-Path $env:ProgramFiles 'NSIS/makensis.exe'), (Join-Path ${env:ProgramFiles(x86)} 'NSIS/makensis.exe'), (Join-Path $appDirectory 'tools/nsis/nsis-3.12/makensis.exe'))
  $found = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($found) { $candidates = @($found.Source) + $candidates }
  foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
  $toolsDirectory = Join-Path $appDirectory 'tools/nsis'
  [IO.Directory]::CreateDirectory($toolsDirectory) | Out-Null
  $archivePath = Join-Path $toolsDirectory 'nsis-3.12.zip'
  Invoke-WebRequest -Uri 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.12/nsis-3.12.zip' -OutFile $archivePath
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $nsisSha256) { throw 'NSIS tool archive checksum mismatch' }
  $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try { foreach ($entry in $zip.Entries) { Assert-SafeMember $entry.FullName $entry.ExternalAttributes | Out-Null } }
  finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $toolsDirectory)
  $binary = Join-Path $toolsDirectory 'nsis-3.12/makensis.exe'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'NSIS executable missing after verified extraction' }
  return $binary
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
Assert-Source
Configure-BuildEnvironment
Select-LocalNode
Push-Location $appDirectory
try {
  if ($Phase -eq 'Bootstrap') {
    Assert-Draft | Out-Null
    Remove-Item -LiteralPath Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
    Get-Command node, npm.cmd, gh, git -ErrorAction Stop | Select-Object Name, Source | Format-Table -AutoSize
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Windows .NET Framework C# compiler is missing' }
    $env:OPENBROWSER_MAKENSIS = Resolve-Nsis
    Write-Host ('Using existing or verified NSIS: ' + $env:OPENBROWSER_MAKENSIS)
    $archivePath = Join-Path $cacheDirectory 'bootstrap-v1.0.8.zip'
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { Invoke-WebRequest -Uri $bootstrapUrl -OutFile $archivePath }
    if ((Get-Item -LiteralPath $archivePath).Length -ne $bootstrapBytes -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bootstrapSha256) { throw 'Published bootstrap ZIP size or SHA256 mismatch' }
    Write-Host 'BOOTSTRAP_ARCHIVE_VERIFIED'
    Invoke-Checked 'npm.cmd' @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
    $runtimePackage = Join-Path $appDirectory 'node_modules/desktop-shell'
    $runtimeDirectory = Join-Path $runtimePackage 'dist'
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    $kernelCount = 0
    try {
      $rootPrefix = $stem + '/'
      $entries = @{}
      foreach ($entry in $zip.Entries) {
        $member = Assert-SafeMember $entry.FullName $entry.ExternalAttributes
        if ($entries.ContainsKey($member)) { throw 'Duplicate bootstrap ZIP member' }
        $entries[$member] = $entry
      }
      $oldRuntimeVersion = (Read-ZipText $entries[($rootPrefix + 'version')]).Trim()
      Write-Host ('Old host version: ' + $oldRuntimeVersion + '. Host files are not copied; locked Electron 43.1.1 will be downloaded and verified by its official npm installer.')
      foreach ($member in $entries.Keys) {
        $entry = $entries[$member]
        if ($member.EndsWith('/')) { continue }
        $kernelPrefix = $rootPrefix + 'resources/app/kernels/'
        if ($member.StartsWith($kernelPrefix, [StringComparison]::Ordinal)) {
          $relative = $member.Substring($kernelPrefix.Length)
          if ($relative -notmatch '^(windows-x64|firefox-reverse)/') { continue }
          if ($relative -match '\.(log|orig)$|(^|/)README\.md$|(^|/)OPENBROWSER_|unlock') { continue }
          if ($relative -match '(^|/)(browser-data|\.cache|Cookies|Login Data|History|Local State|prefs\.js|user\.js)(/|$)') { throw 'Private state found in bootstrap kernel' }
          $kernelsDirectory = Join-Path $appDirectory 'kernels'
          Copy-ZipMember $entry (Join-Path $kernelsDirectory $relative) $kernelsDirectory
          $kernelCount++
        }
      }
    } finally { $zip.Dispose() }
    if ($kernelCount -lt 100) { throw 'Bootstrap has insufficient integrated kernel files' }
    foreach ($variable in @('ELECTRON_MIRROR', 'ELECTRON_CUSTOM_DIR', 'ELECTRON_CUSTOM_FILENAME', 'ELECTRON_SKIP_BINARY_DOWNLOAD', 'ELECTRON_OVERRIDE_DIST_PATH')) { Remove-Item -LiteralPath ('Env:' + $variable) -ErrorAction SilentlyContinue }
    Invoke-Checked 'node' @((Join-Path $runtimePackage 'install.js'))
    if ((Get-Content -LiteralPath (Join-Path $runtimeDirectory 'version') -Raw).Trim() -cne '43.1.1') { throw 'Restored desktop runtime version mismatch' }
    Invoke-Checked 'node' @('scripts/patch-windows-kernel.js')
    Invoke-Checked 'node' @('scripts/prepare-bundled-kernel.js')
    $kernelHashes = @{
      'windows-x64/chrome.exe' = 'c24aab659c0712f3fd2a5bb8e148f403b6838c452abb0cd055affcfbe0497506'
      'windows-x64/chrome.dll' = 'e19419d719abe1d8d6d3698eb4350e9fac8b19bbe2cee0ab26bdbe0061bba580'
      'firefox-reverse/firefox.exe' = '3f868ce834fca2798b65a98008f55b9a4520c92e7f6160ca402e52fa87ba3fd7'
      'firefox-reverse/xul.dll' = '9b1c600428d309142301f1d65c3e60622dc3d8ae7494d0d2493923b6d0f326e9'
    }
    foreach ($relative in $kernelHashes.Keys) {
      if ((Get-FileHash -LiteralPath (Join-Path $appDirectory ('kernels/' + $relative)) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $kernelHashes[$relative]) { throw ('Integrated kernel differs from verified local release seed: ' + $relative) }
    }
    Assert-Source
    [IO.File]::WriteAllText((Join-Path $cacheDirectory 'bootstrap-manifest.json'), (@{ version=$version; commit=$SourceCommit; archiveSha256=$bootstrapSha256; kernelFiles=$kernelCount; runtime='official-electron-43.1.1'; nsis=$env:OPENBROWSER_MAKENSIS } | ConvertTo-Json -Depth 4), $utf8)
    Write-Host 'BOOTSTRAP_COMPLETE: published seeds verified; latest product source retained'
  } elseif ($Phase -eq 'Build') {
    $bootstrap = Get-Content -LiteralPath (Join-Path $cacheDirectory 'bootstrap-manifest.json') -Raw | ConvertFrom-Json
    if ($bootstrap.commit -cne $SourceCommit -or $bootstrap.version -cne $version -or $bootstrap.archiveSha256 -cne $bootstrapSha256) { throw 'Bootstrap provenance mismatch' }
    $env:OPENBROWSER_MAKENSIS = $bootstrap.nsis
    foreach ($test in @('privacy-hardening-selftest.js', 'fingerprint-failure-lifecycle-selftest.js', 'package-resource-selftest.js', 'desktop-packaging-ui-selftest.js')) { Invoke-Checked 'node' @($test) }
    Invoke-Checked 'node' @('scripts/package-portable.js')
    Assert-Source
    $verificationDirectory = Join-Path $cacheDirectory 'verification'
    [IO.Directory]::CreateDirectory($verificationDirectory) | Out-Null
    $zipPath = Join-Path $distDirectory ($stem + '.zip')
    $portablePath = Join-Path $distDirectory ($stem + '-Portable.exe')
    $setupPath = Join-Path $distDirectory ($stem + '-Setup.exe')
    $zipResult = & (Join-Path $PSScriptRoot 'verify-windows-release.ps1') -SourceRoot $appDirectory -PackageRoot $packageDirectory -ZipPath $zipPath -Version $version
    [IO.File]::WriteAllText((Join-Path $verificationDirectory 'zip.json'), ($zipResult -join "`n"), $utf8)
    $nsisResult = Get-CheckedOutput 'node' @((Join-Path $PSScriptRoot 'verify-nsis-release.js'), $appDirectory, $packageDirectory, $version, $portablePath, $setupPath)
    [IO.File]::WriteAllText((Join-Path $verificationDirectory 'nsis.jsonl'), $nsisResult, $utf8)
    $assets = @()
    $checksumLines = @()
    foreach ($file in @($zipPath, $portablePath, $setupPath)) {
      $info = Get-Item -LiteralPath $file
      if ($info.Length -ge 2GB) { throw 'Release asset exceeds GitHub size limit' }
      if ($file.EndsWith('.exe')) {
        $pe = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
        if ($pe.FileVersion -cne $version -or $pe.ProductVersion -cne $version) { throw 'NSIS product version mismatch' }
      }
      $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
      $assets += @{ name=$info.Name; size=$info.Length; sha256=$hash }
      $checksumLines += $hash + '  ' + $info.Name
    }
    $checksumPath = Join-Path $distDirectory 'SHA256SUMS.txt'
    [IO.File]::WriteAllText($checksumPath, (($checksumLines -join "`n") + "`n"), $utf8)
    $checksumInfo = Get-Item -LiteralPath $checksumPath
    $assets += @{ name=$checksumInfo.Name; size=$checksumInfo.Length; sha256=(Get-FileHash -LiteralPath $checksumPath -Algorithm SHA256).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText($manifestPath, (@{ version=$version; sourceCommit=$SourceCommit; assets=$assets } | ConvertTo-Json -Depth 5), $utf8)
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value ('Verified v' + $version + ' from ' + $SourceCommit + '. Static package checks passed; files will be uploaded only to the existing draft.') }
    Write-Host 'BUILD_COMPLETE: all packages verified and server SHA256SUMS generated'
  } else {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.version -cne $version -or $manifest.sourceCommit -cne $SourceCommit -or $manifest.assets.Count -ne 4) { throw 'Build manifest does not match controlled product source' }
    $allowedAssets = @(($stem + '.zip'), ($stem + '-Portable.exe'), ($stem + '-Setup.exe'), 'SHA256SUMS.txt')
    foreach ($asset in $manifest.assets) {
      if ($allowedAssets -cnotcontains $asset.name) { throw 'Unexpected upload artifact name' }
      $file = Join-Path $distDirectory $asset.name
      if ((Get-Item -LiteralPath $file).Length -ne $asset.size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $asset.sha256) { throw 'Artifact changed since static verification' }
      Assert-Draft | Out-Null
      Invoke-Checked 'gh' @('release', 'upload', $ReleaseTag, '--repo', $repository, '--clobber', $file)
      Write-Host ('Uploaded verified draft asset: ' + $asset.name)
    }
    $release = Assert-Draft
    foreach ($asset in $manifest.assets) {
      $remote = @($release.assets | Where-Object { $_.name -ceq $asset.name })
      if ($remote.Count -ne 1 -or $remote[0].state -cne 'uploaded' -or $remote[0].size -ne $asset.size -or $remote[0].digest -cne ('sha256:' + $asset.sha256)) { throw ('Remote asset does not match server manifest: ' + $asset.name) }
    }
    Invoke-Checked 'gh' @('release', 'edit', $ReleaseTag, '--repo', $repository, '--notes-file', (Join-Path $projectDirectory ('docs/releases/' + $ReleaseTag + '.md')))
    Assert-Draft | Out-Null
    Write-Host 'DRAFT_UPLOAD_COMPLETE: all four digests match; release remains unpublished'
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value ('All four verified assets uploaded to draft ' + $ReleaseTag + '; parent task must verify and publish explicitly.') }
  }
} finally { Pop-Location }
