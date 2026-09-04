# Fail-first gateway health probe. Read-only: GET /api/health, expect 200 + {"ok":true}.
# Usage: .\verify-health.ps1 [-BaseUrl http://localhost:20128] [-TimeoutSec 10]
param(
  [string]$BaseUrl = 'http://localhost:20128',
  [int]$TimeoutSec = 10
)
$ErrorActionPreference = 'Stop'
$uri = "$BaseUrl/api/health"
try {
  $res = Invoke-WebRequest -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing
} catch {
  Write-Host "FAIL: gateway unreachable at $uri : $($_.Exception.Message)"
  exit 1
}
if ($res.StatusCode -ne 200) {
  Write-Host "FAIL: GET $uri -> HTTP $($res.StatusCode), expected 200"
  exit 1
}
try {
  $body = $res.Content | ConvertFrom-Json
} catch {
  Write-Host 'FAIL: /api/health body is not JSON'
  exit 1
}
$healthy = ($body.ok -eq $true) -or ($body.status -eq 'ok')
if (-not $healthy) {
  Write-Host "FAIL: /api/health healthy flag missing : $($res.Content)"
  exit 1
}
Write-Host "PASS: gateway healthy at $uri (200, $($res.Content.Trim()))"
