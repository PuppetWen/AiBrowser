param(
  [ValidateSet('Check', 'Install')][string]$Action = 'Check',
  [Parameter(Mandatory=$true)][string]$BrowserPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ruleGroup = 'AiBrowser Strict Privacy v1'
$remoteAddresses = @('0.0.0.0-127.0.0.0', '127.0.0.2-255.255.255.255', '::/128', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')

function Get-RuleName([string]$Program) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Program.ToLowerInvariant()))).Replace('-', '').Substring(0, 24) }
  finally { $sha.Dispose() }
  return 'AiBrowser-Privacy-v1-' + $hash
}

function Normalize-Address([string]$Address) {
  # Windows may expand IPv6 spelling or omit a host-only /128 prefix.
  $parts = ($Address -replace '/128$', '') -split '-'
  return (($parts | ForEach-Object { [Net.IPAddress]::Parse($_).ToString().ToLowerInvariant() }) -join '-')
}

try {
  $resolvedBrowser = (Resolve-Path -LiteralPath $BrowserPath).ProviderPath
  if ([IO.Path]::GetExtension($resolvedBrowser) -ne '.exe') { throw 'Browser must be an executable' }
  $kernelDirectory = Split-Path -Parent $resolvedBrowser
  if ($kernelDirectory -eq [IO.Path]::GetPathRoot($kernelDirectory)) { throw 'Unsafe kernel directory' }
  $ancestor = Get-Item -LiteralPath $kernelDirectory
  while ($ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Kernel path must not contain a junction or symlink' }
    $ancestor = $ancestor.Parent
  }
  # No global firewall defaults, adapters or unrelated programs are changed.
  # Protect every companion executable in the selected independent kernel.
  $children = @(Get-ChildItem -LiteralPath $kernelDirectory -Recurse)
  if (@($children | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Kernel directory must not contain junctions or symlinks' }
  $programs = @($children | Where-Object { -not $_.PSIsContainer -and $_.Extension -eq '.exe' } | ForEach-Object { $_.FullName })
  if ($programs.Count -eq 0 -or $programs.Count -gt 100) { throw 'Unexpected kernel executable count' }
  $admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($Action -eq 'Install' -and -not $admin) {
    # Invoked only by the explicit Install button. Windows itself displays UAC.
    if ($resolvedBrowser.Contains('"') -or $PSCommandPath.Contains('"')) { throw 'Invalid executable path' }
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action Install -BrowserPath "' + $resolvedBrowser + '"'
    $child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
    $child.WaitForExit()
    if ($child.ExitCode -ne 0) { throw 'Network protection installation was cancelled or failed' }
  } elseif ($Action -eq 'Install') {
    foreach ($program in $programs) {
      $name = Get-RuleName $program
      $existing = Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue
      if ($existing) {
        if ($existing.Group -ne $ruleGroup) { throw 'Firewall rule ownership mismatch' }
        # Restore our rule in place; do not remove it while a browser may run.
        Set-NetFirewallRule -PolicyStore PersistentStore -Name $name -Enabled True -Direction Outbound -Action Block -Profile Any -Program $program -Protocol Any -RemoteAddress $remoteAddresses -LocalAddress Any -LocalPort Any -RemotePort Any -InterfaceType Any -Service Any | Out-Null
      } else {
        New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName ('AiBrowser privacy - ' + [IO.Path]::GetFileName($program)) -Group $ruleGroup -Description 'Block non-loopback IPv4/IPv6 for this AiBrowser kernel. Keep this rule when AiBrowser exits.' -Enabled True -Direction Outbound -Action Block -Profile Any -Program $program -Protocol Any -RemoteAddress $remoteAddresses | Out-Null
      }
    }
  }
  if ((Get-Service -Name MpsSvc).Status -ne 'Running') { throw 'Windows Firewall service is not running' }
  $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
  if ($profiles.Count -ne 3 -or @($profiles | Where-Object { $_.Enabled -ne $true }).Count -gt 0) { throw 'Windows Firewall must be enabled for all network profiles' }
  foreach ($profile in $profiles) {
    if (@($profile.DisabledInterfaceAliases | Where-Object { $_ -and $_ -ne 'NotConfigured' }).Count) { throw 'Windows Firewall has excluded network interfaces. Launch blocked.' }
    if ($profile.AllowLocalFirewallRules -eq 'False') { throw 'Local firewall rules are disabled by policy. Launch blocked.' }
  }
  foreach ($program in $programs) {
    $name = Get-RuleName $program
    $rule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction SilentlyContinue
    if (-not $rule -or $rule.Group -ne $ruleGroup -or $rule.Enabled -ne 'True' -or $rule.Direction -ne 'Outbound' -or $rule.Action -ne 'Block' -or $rule.Profile -ne 'Any') { throw 'Network protection is missing or disabled. Click Install network protection.' }
    $application = $rule | Get-NetFirewallApplicationFilter
    $address = $rule | Get-NetFirewallAddressFilter
    $port = $rule | Get-NetFirewallPortFilter
    $service = $rule | Get-NetFirewallServiceFilter
    $interface = $rule | Get-NetFirewallInterfaceFilter
    $interfaceType = $rule | Get-NetFirewallInterfaceTypeFilter
    if ($application.Program -ne $program -or $application.Package -notin @('Any', $null, '') -or $port.Protocol -ne 'Any' -or $port.LocalPort -ne 'Any' -or $port.RemotePort -ne 'Any' -or $service.Service -ne 'Any' -or $address.LocalAddress -ne 'Any' -or $interface.InterfaceAlias -ne 'Any' -or $interfaceType.InterfaceType -ne 'Any') { throw 'Network protection scope was modified. Launch blocked.' }
    $expectedAddresses = @($remoteAddresses | ForEach-Object { Normalize-Address $_ } | Sort-Object)
    $actualAddresses = @($address.RemoteAddress | ForEach-Object { Normalize-Address $_ } | Sort-Object)
    if (@(Compare-Object $expectedAddresses $actualAddresses).Count -ne 0) { throw 'Network protection IPv4/IPv6 ranges are incomplete. Launch blocked.' }
    if ($rule.PrimaryStatus -ne 'OK' -or $rule.EnforcementStatus -notin @('Full', 'NotApplicable')) { throw 'Windows policy prevents enforcement of the network protection rule' }
  }
  @{ ok=$true; protectedExecutables=$programs.Count; persistent=$true; scope='aibrowser-kernel-loopback-only' } | ConvertTo-Json -Compress
} catch {
  @{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 2
}
