# Relay egress check. Read-only probes via socks5h://127.0.0.1:1090 to https://api64.ipify.org.
# Passes when >1 distinct egress IP observed; a single egress is recorded as a note (exit 0) unless -RequireDistinct.
# Usage: .\verify-relay.ps1 [-Probes 6] [-RequireDistinct]
param(
  [int]$Probes = 6,
  [switch]$RequireDistinct
)
$ErrorActionPreference = 'Stop'
$ips = @()
for ($i = 1; $i -le $Probes; $i++) {
  try {
    $ip = curl.exe -s --max-time 15 --proxy socks5h://127.0.0.1:1090 https://api64.ipify.org 2>$null
  } catch { $ip = '' }
  $ip = ($ip | Out-String).Trim()
  if ($ip) { $ips += $ip }
  Start-Sleep -Milliseconds 300
}
$uniq = $ips | Sort-Object -Unique
Write-Host "probes=$Probes ok=$($ips.Count) distinct=$($uniq.Count) ips=$($uniq -join ',')"
if ($ips.Count -eq 0) {
  Write-Host 'FAIL: relay :1090 unreachable or all probes timed out'
  exit 1
}
if ($uniq.Count -gt 1) {
  Write-Host "PASS: distinct egress IPs observed via :1090 ($($uniq -join ', '))"
  exit 0
}
Write-Host 'NOTE: single egress IP only (pool pinned or one account live) — not a failure by itself'
if ($RequireDistinct) { exit 1 }
exit 0
