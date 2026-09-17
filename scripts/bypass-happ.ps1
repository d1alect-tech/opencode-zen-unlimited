#Requires -Version 5.1
<#
.SYNOPSIS
  Bypass happ TUN for sing-box egress (persistent /32 via physical gateway).
.DESCRIPTION
  happ raises happ-default-tun with a metric-0 default (0.0.0.0/1 + 128/1),
  so every sing-box outbound dials its egress node through happ's IP - Zen
  per-IP quota then counts on one IP and the pool loses its point.
  This script reads sing-box/config.json egress servers, resolves them to
  IPv4, and pins persistent /32 routes via the physical gateway (beats TUN
  by longest-prefix). Re-run after `zen add-sub`, node IP changes, or a
  network change (new gateway). New connections take the new path;
  restart sing-box so QUIC sessions re-dial (existing sessions linger).
.EXAMPLE
  .\scripts\bypass-happ.ps1 -WhatIf   # preview, no admin needed
  .\scripts\bypass-happ.ps1           # apply (self-elevates via UAC)
  .\scripts\bypass-happ.ps1 -Revert   # delete the pinned routes
#>
param(
  [switch]$WhatIf,
  [switch]$Revert
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Preview needs no admin; apply/revert self-elevate like install-zen-stack.ps1.
if (-not $WhatIf -and -not (Test-Admin)) {
  $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath)
  if ($Revert) { $args += "-Revert" }
  Start-Process powershell.exe -ArgumentList $args -Verb RunAs
  echo "Relaunched elevated (UAC) - see the new window."
  exit 0
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$configPath = Join-Path $repoRoot "sing-box\config.json"
if (-not (Test-Path $configPath)) { throw "missing $configPath (run from repo checkout)" }

# Physical default: 0.0.0.0/0 with lowest metric, excluding happ TUN + Radmin.
$phys = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" |
  Where-Object { $_.InterfaceAlias -notlike "*happ*" -and $_.InterfaceAlias -notlike "*Radmin*" -and $_.NextHop -ne "0.0.0.0" } |
  Sort-Object RouteMetric | Select-Object -First 1
if ($null -eq $phys) { throw "no physical default route found (happ-only machine?)" }
$gw = $phys.NextHop
echo "physical gateway: $gw via $($phys.InterfaceAlias)"

$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$servers = @($cfg.outbounds | Where-Object { $_.server } | ForEach-Object { $_.server } | Sort-Object -Unique)
$ips = @("1.1.1.1")  # sing-box DoH resolver - pin it too so DNS survives happ down
foreach ($s in $servers) {
  $parsed = $null
  if ([System.Net.IPAddress]::TryParse($s, [ref]$parsed)) {
    if ($s -notmatch ":") { $ips += $s }  # v4 literals only
  } else {
    try {
      [System.Net.Dns]::GetHostAddresses($s) |
        Where-Object { $_.AddressFamily -eq "InterNetwork" } |
        ForEach-Object { $ips += $_.IPAddressToString }
    } catch { Write-Warning "resolve fail: $s - skipped this run" }
  }
}
$ips = @($ips | Sort-Object -Unique)

$action = if ($Revert) { "DELETE" } else { "ADD -p" }
foreach ($ip in $ips) {
  if ($WhatIf) {
    echo "route.exe $action $ip MASK 255.255.255.255 $gw METRIC 1"
  } elseif ($Revert) {
    route.exe DELETE $ip | Out-Null
    echo "deleted $ip"
  } else {
    route.exe -p ADD $ip MASK 255.255.255.255 $gw METRIC 1 | Out-Null
    echo "pinned $ip via $gw"
  }
}
if (-not $WhatIf) {
  echo "done. Verify: Find-NetRoute -RemoteIPAddress $($ips[1]) | Select InterfaceAlias"
  echo "Then restart sing-box so sessions re-dial outside happ."
}
