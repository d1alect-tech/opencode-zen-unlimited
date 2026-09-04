@echo off
REM One-click elevated install of the zen Task Scheduler stack.
REM Usage: right-click this file -> "Run as administrator", approve the UAC prompt.
REM Registers oc-singbox/oc-relay/oc-gateway (staggered boot) + oc-watchdog (PT5M self-heal),
REM pointing at the project-local ./bin/sing-box.exe and sing-box/config.json.
REM Verify afterwards (non-elevated): bun run src/index.ts doctor
set "ROOT=%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0install-scheduler.ps1\" -SingBoxBin \"%~dp0..\bin\sing-box.exe\"' -Verb RunAs"
