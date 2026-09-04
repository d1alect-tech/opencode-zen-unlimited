# QA gateway pattern (Windows)

Lesson: `bun -e "serve..."` in the foreground hangs the agent
session — the server owns the shell and the turn never ends.

Always use this shape for live gateway QA:

1. Write a temp script file (never `bun -e` inline for a server):

   ```powershell
   Set-Content qa-tmp.ts 'import { createApp } from "./src/gateway/app.ts"; ...'
   ```

2. Start it in the background, capturing the PID:

   ```powershell
   $p = Start-Process bun -ArgumentList 'qa-tmp.ts' -PassThru
   Start-Sleep -Seconds 2
   ```

3. Probe with `curl.exe` (fail-first, short timeouts):

   ```powershell
   curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:20128/api/health
   # or against a QA port (e.g. 20199) to avoid touching live :20128
   ```

4. Kill by PID, then delete the temp file:

   ```powershell
   Stop-Process -Id $p.Id -Force
   Remove-Item qa-tmp.ts
   ```

Rules:

- NEVER bare `bun -e serve` (or any foreground server) in an agent turn.
- NEVER probe destructively on live `:20128`/`:1090` — read-only
  GETs are ok; prefer a QA port for anything stateful.
- Prefer the checked-in scripts: `scripts/verify-health.ps1`,
  `scripts/verify-relay.ps1`, `scripts/verify-spark-e2e.ps1`
  (last one is OPTIONAL/live — consumes real upstream quota).
- Timeouts everywhere (`-TimeoutSec`, `--max-time`); fail-first
  with `exit 1` and a one-line reason.
