<#
.SYNOPSIS
  One-file installer for the zen egress stack (Task Scheduler, Windows-only).

.DESCRIPTION
  Registers oc-singbox / oc-relay / oc-gateway (staggered boot delays) plus
  oc-watchdog (self-heal every 5 min), starts everything immediately, then
  verifies the ports. Replaces the old .cmd + .ps1 split: this script
  re-launches itself elevated, so there is nothing to right-click.

  Why one file: the previous flow needed a .cmd elevation wrapper plus a
  generator script, and its generated wrappers had fragile nested quoting
  plus a broken exit-code echo. This file generates robust wrappers
  (argument arrays, real exit codes) with full tool paths embedded, because
  the SYSTEM account has no user PATH (bare `bun` would not resolve at boot).

.USAGE
  # From any PowerShell (auto-elevates via UAC prompt):
  .\scripts\install-zen-stack.ps1
  # Preview without changing anything (no elevation needed):
  .\scripts\install-zen-stack.ps1 -WhatIf
  # Remove all four tasks:
  .\scripts\install-zen-stack.ps1 -Unregister

.EXIT CODES
  0 = ok, 1 = registration/startup failure, 2 = usage error.
#>
param(
  [string]$SingBoxBin = '',
  [string]$SingBoxConfig = '',
  [switch]$Unregister,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

# Transcript first: if the elevated window closes instantly (e.g. under
# PowerRun), the full error stays in this log file next to the script.
$LogFile = Join-Path $PSScriptRoot 'install-zen-stack.log'
try { Start-Transcript -Path $LogFile -Append | Out-Null } catch { }
Write-Host "[log] $LogFile"
Write-Host "[whoami] $(whoami)"

# --- Self-elevation (replaces the old .cmd wrapper) ---
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin -and -not $WhatIf) {
  $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($Unregister) { $argList += ' -Unregister' }
  if ($SingBoxBin) { $argList += " -SingBoxBin `"$SingBoxBin`"" }
  if ($SingBoxConfig) { $argList += " -SingBoxConfig `"$SingBoxConfig`"" }
  Start-Process powershell -ArgumentList $argList -Verb RunAs
  exit 0
}
Write-Host "[admin] elevated=$IsAdmin"

$Root = Split-Path -Parent $PSScriptRoot

function Invoke-Plan {
  param([string]$Step, [scriptblock]$Action)
  if ($WhatIf) { Write-Host "WhatIf: $Step"; return $null }
  return & $Action
}

# --- Resolve tools (full paths: SYSTEM has no user PATH) ---
if (-not $SingBoxBin) {
  $localBin = Join-Path $Root 'bin\sing-box.exe'
  $SingBoxBin = if (Test-Path $localBin) { $localBin } else { 'sing-box' }
}
if (-not $SingBoxConfig) {
  $gen = Join-Path $Root 'sing-box\config.json'
  $example = Join-Path $Root 'sing-box\config.example.json'
  $SingBoxConfig = if (Test-Path $gen) { $gen } else { $example }
}
function Find-ToolExe {
  param([string]$Name, [string[]]$Fallbacks)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  # Elevated contexts (Task Scheduler SYSTEM, PowerRun/TI) often have a
  # minimal PATH without user-level bun/node. Probe well-known locations.
  foreach ($p in $Fallbacks) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}
if (-not $WhatIf) {
  if (-not (Get-Command $SingBoxBin -ErrorAction SilentlyContinue) -and -not (Test-Path $SingBoxBin)) {
    Write-Error "tool not found: $SingBoxBin (see $LogFile)"
    exit 2
  }
}
$BunExe = if ($WhatIf) { '<bun>' } else {
  Find-ToolExe 'bun.exe' @("$env:USERPROFILE\.bun\bin\bun.exe", "$env:ProgramFiles\bun\bun.exe")
}
$NodeExe = if ($WhatIf) { '<node>' } else {
  Find-ToolExe 'node.exe' @("$env:ProgramFiles\nodejs\node.exe", "$env:USERPROFILE\.fnm\node-versions\*\installation\node.exe")
}
if (-not $WhatIf) {
  foreach ($pair in @(@('bun', $BunExe), @('node', $NodeExe))) {
    if (-not $pair[1]) {
      Write-Error "tool not found: $($pair[0]) (PATH + fallback locations checked; see $LogFile)"
      exit 2
    }
    Write-Host "[tool] $($pair[0]) -> $($pair[1])"
  }
}
$ZenEntry = Join-Path $Root 'src\index.ts'
$ZenDist = Join-Path $Root 'dist\index.js'
if ((Test-Path $ZenDist) -and (-not $WhatIf)) { $ZenEntry = $ZenDist }

$Tasks = @(
  @{ Name = 'oc-singbox'; Delay = 'PT1M'; Exe = $SingBoxBin; Args = @('run', '-c', $SingBoxConfig) },
  @{ Name = 'oc-relay'; Delay = 'PT2M'; Exe = $NodeExe; Args = @((Join-Path $Root 'src\relay\rr-socks.mjs')) },
  @{ Name = 'oc-gateway'; Delay = 'PT3M'; Exe = $BunExe; Args = @('run', $ZenEntry) },
  @{ Name = 'oc-watchdog'; Delay = 'PT5M'; Exe = $BunExe; Args = @('run', $ZenEntry, 'status', '--self-heal'); Once = $true }
)

if ($Unregister) {
  foreach ($t in $Tasks) {
    Invoke-Plan "schtasks /Delete /TN $($t.Name) /F" {
      schtasks /Delete /TN $t.Name /F 2>$null | Out-Null
    }
    Write-Host "removed $($t.Name)"
  }
  exit 0
}

function New-WrapperBody {
  param([hashtable]$Task)
  # Single-quoted here-strings: nothing expands at generation time, so
  # $LASTEXITCODE-style bugs are impossible; args travel as an array,
  # so paths with spaces need no nested quoting.
  $exeLine = "  `$Exe = '$($Task.Exe)'"
  $argLines = foreach ($a in $Task.Args) { "    '$($a.Replace("'", "''"))'" }
  $head = @(
    '# generated by install-zen-stack.ps1 - hands off'
    "`$ErrorActionPreference = 'Continue'"
    "`$Name = '$($Task.Name)'"
    $exeLine
    '$ArgList = @('
  ) + $argLines + @(
    ')'
    "Set-Location '$Root'"
  )
  if ($Task.Once) {
    return $head + @(
      'Write-Host "[$Name] start: $Exe $($ArgList -join '' '')"'
      '$p = Start-Process -FilePath $Exe -ArgumentList $ArgList -NoNewWindow -Wait -PassThru'
      'exit $p.ExitCode'
    )
  }
  return $head + @(
    'while ($true) {'
    '  Write-Host "[$Name] start: $Exe $($ArgList -join '' '')"'
    '  $p = Start-Process -FilePath $Exe -ArgumentList $ArgList -NoNewWindow -Wait -PassThru'
    '  Write-Host "[$Name] exited $($p.ExitCode) - restart in 60s"'
    '  Start-Sleep -Seconds 60'
    '}'
  )
}

function Test-Port {
  param([string]$Host, [int]$Port, [int]$TimeoutMs = 3000)
  try {
    $client = New-Object Net.Sockets.TcpClient
    $iar = $client.BeginConnect($Host, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($iar)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Invoke-Native {
  # Native exes (schtasks) write to stderr on any warning; with
  # $ErrorActionPreference='Stop' that used to kill the whole install with
  # no step marker. Here stderr is tolerated and only a nonzero exit fails.
  param([string]$Step, [scriptblock]$Action)
  Write-Host "[step] $Step"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Action } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "native call failed (exit $LASTEXITCODE): $Step (see $LogFile)" }
}

function New-TaskXml {
  # Single-shot registration: the full task (SYSTEM principal, boot trigger
  # with stagger delay, RestartOnFailure, watchdog PT5M repetition) is
  # imported in one schtasks call - no Query/patch/Create roundtrip.
  param([hashtable]$Task, [string]$Wrapper)
  $psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $repetition = ''
  if ($Task.Once) {
    $repetition = '<Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>'
  }
  @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>zen egress stack: $($Task.Name) (generated by install-zen-stack.ps1)</Description></RegistrationInfo>
  <Triggers><BootTrigger><Delay>$($Task.Delay)</Delay><Enabled>true</Enabled>$repetition</BootTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>$psExe</Command><Arguments>-NoProfile -ExecutionPolicy Bypass -File "$Wrapper"</Arguments></Exec></Actions>
</Task>
"@
}

foreach ($t in $Tasks) {
  $wrapper = Join-Path $PSScriptRoot "$($t.Name)-run.ps1"
  Invoke-Plan "write $wrapper" {
    Set-Content -Path $wrapper -Encoding UTF8 -Value (New-WrapperBody $t)
  }
  Invoke-Plan "register $($t.Name) via XML import" {
    $xml = New-TaskXml $t $wrapper
    $tmp = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $tmp -Encoding Unicode -Value $xml
    Invoke-Native "schtasks /Create /TN $($t.Name) /XML" {
      schtasks /Create /TN $t.Name /XML $tmp /F
    }
    Remove-Item $tmp -Force
  }
  Invoke-Plan "schtasks /Run /TN $($t.Name)" {
    Invoke-Native "schtasks /Run /TN $($t.Name)" { schtasks /Run /TN $t.Name }
  }
  if (-not $WhatIf) { Write-Host "registered+started $($t.Name) (boot delay $($t.Delay))" }
}

if ($WhatIf) {
  Write-Host 'WhatIf complete: no changes made.'
  exit 0
}

Write-Host 'Start order after reboot: oc-singbox -> oc-relay -> oc-gateway (PT1M/PT2M/PT3M delays).'
Start-Sleep -Seconds 10
$ok = $true
foreach ($port in @(1090, 20128)) {
  if (Test-Port '127.0.0.1' $port) {
    Write-Host "[ok] 127.0.0.1:$port listening"
  } else {
    Write-Host "[warn] 127.0.0.1:$port not listening yet (services may still be starting)"
    $ok = $false
  }
}
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:20128/api/health' -TimeoutSec 5
  if ($health.ok -eq $true) { Write-Host '[ok] gateway /api/health ok' }
  else { Write-Host '[warn] gateway health unexpected'; $ok = $false }
} catch {
  Write-Host '[warn] gateway /api/health unreachable yet'; $ok = $false
}
if (-not $ok) {
  Write-Host 'verification incomplete: wait a minute and run bun run src/index.ts doctor'
  exit 1
}
Write-Host 'install complete: all tasks registered, started, and verified.'
exit 0
