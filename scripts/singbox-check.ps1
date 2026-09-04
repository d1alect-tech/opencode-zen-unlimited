# Requires sing-box >= 1.14.0.
# NOTE: xhttp / splithttp does NOT exist in sing-box — never spec it.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
sing-box check -c (Join-Path $Root 'sing-box/config.example.json')
