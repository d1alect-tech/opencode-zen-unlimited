#!/usr/bin/env pwsh
# Secrets hygiene gate: fails on real-looking secrets, allows YOUR_* placeholders + example.com fixtures.
# Usage: pwsh scripts/check-secrets.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Violations = @()

# 1. Real-looking secret assignments. Code-shape lines (field refs, decoders, env reads,
#    comparisons) are skipped — only literal values count.
$AssignRe = '(?i)(password|passwd|api[_-]?key|secret|RR_WATCH_TOKEN|HY2_PASSWORD|EGRESS_SUB_URL)\s*[:=]\s*["'']?(?!YOUR_)(?!example\.com)([A-Za-z0-9\-_./:?&=]{8,})["'']?'
$CodeShapeRe = 'node\.|process\.env|decodeURIComponent|userinfo|String\(|p\[|===|!==|\?\?|typeof|=>|function |import |^\s*//|\* '
$ScanGlobs = @('src', 'sing-box', 'scripts', 'docs', 'opencode', '*.md', '*.jsonc')
foreach ($g in $ScanGlobs) {
  $base = Join-Path $Root $g
  if (-not (Test-Path $base)) { continue }
  $files = Get-ChildItem -Path $base -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' -and $_.FullName -notmatch '[\\/]\.scratch[\\/]' -and $_.FullName -notmatch 'node_modules' }
  foreach ($f in $files) {
    if ($f.Name -eq 'check-secrets.ps1' -or $f.Name -eq 'check-secrets.sh') { continue }
    $n = 0
    foreach ($line in (Get-Content -Path $f.FullName -ErrorAction SilentlyContinue)) {
      $n++
      if ($line -match $CodeShapeRe) { continue }
      if ($line -match 'YOUR_' -and $line -notmatch '(?i)(sk-ant-|sk-proj-|ghp_|xoxb-|AKIA)') { continue }
      if ($line -match $AssignRe) {
        $hit = $Matches[0]
        if ($hit -match 'example\.com|YOUR_') { continue }
        $Violations += "$($f.FullName):$n`: $hit"
      }
    }
  }
}

# 2. Well-known token formats anywhere (never placeholders).
$TokenRe = '(sk-ant-|sk-proj-|ghp_[A-Za-z0-9]{8,}|xoxb-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
$AllFiles = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' -and $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.FullName -notmatch '[\\/]dist[\\/]' -and $_.Name -notmatch '^bun\.lock$' }
foreach ($f in $AllFiles) {
  if ($f.Name -eq 'check-secrets.ps1' -or $f.Name -eq 'check-secrets.sh') { continue }
  $n = 0
  foreach ($line in (Get-Content -Path $f.FullName -ErrorAction SilentlyContinue)) {
    $n++
    if ($line -match $TokenRe) { $Violations += "$($f.FullName):$n`: token-format match" }
  }
}

# 3. sing-box example must stay placeholder-only (no real hostnames in server/server_name/password).
$Cfg = Join-Path $Root 'sing-box/config.example.json'
if (Test-Path $Cfg) {
  $txt = Get-Content -Path $Cfg -Raw
  $InfraAllow = @('1.1.1.1', 'cloudflare-dns.com', 'www.gstatic.com')
  foreach ($m in [regex]::Matches($txt, '"(server|server_name|password)"\s*:\s*"([^"]+)"')) {
    $val = $m.Groups[2].Value
    if ($val -like 'YOUR_*') { continue }
    if ($InfraAllow -contains $val) { continue }
    $Violations += "${Cfg}: non-placeholder $($m.Groups[1].Value)=$val"
  }
}

if ($Violations.Count -gt 0) {
  Write-Host 'check-secrets: VIOLATIONS' -ForegroundColor Red
  $Violations | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  exit 1
}
Write-Host 'check-secrets: OK'
