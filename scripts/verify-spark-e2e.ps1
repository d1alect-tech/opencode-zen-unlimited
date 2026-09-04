# OPTIONAL / live upstream call. POST /v1/responses model oc/muse-spark-1.3-contributor-free, input "ping".
# Expect HTTP 200 and a non-500 body. Hits real opencode.ai/zen quota — run sparingly.
# Usage: .\verify-spark-e2e.ps1 [-BaseUrl http://localhost:20128] [-TimeoutSec 60]
param(
  [string]$BaseUrl = 'http://localhost:20128',
  [int]$TimeoutSec = 60
)
$ErrorActionPreference = 'Stop'
Write-Host 'NOTE: OPTIONAL/live — consumes real upstream quota via /v1/responses.'
$uri = "$BaseUrl/v1/responses"
$payload = '{"model":"oc/muse-spark-1.3-contributor-free","input":"ping"}'
try {
  $res = Invoke-WebRequest -Uri $uri -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec $TimeoutSec -UseBasicParsing
  $code = $res.StatusCode
  $text = $res.Content
} catch {
  $resp = $_.Exception.Response
  if ($resp -ne $null) {
    $code = [int]$resp.StatusCode
    $text = ''
    try {
      $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $text = $sr.ReadToEnd()
    } catch {}
    Write-Host "FAIL: POST $uri -> HTTP $code body: $text"
    exit 1
  }
  Write-Host "FAIL: POST $uri unreachable : $($_.Exception.Message)"
  exit 1
}
if ($code -ne 200) {
  Write-Host "FAIL: POST $uri -> HTTP $code, expected 200. body: $text"
  exit 1
}
if ([string]::IsNullOrWhiteSpace($text) -or $text -match '"error"' -or $text -match 'format must match request format') {
  Write-Host "FAIL: upstream returned error/format-mismatch body: $text"
  exit 1
}
Write-Host "PASS: spark e2e 200 via $uri (body $($text.Length) chars)"
