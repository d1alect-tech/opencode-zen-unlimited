# Configure the `oc/` provider (any IDE, any agent)

Wire any OpenCode client — terminal, VS Code extension, or other IDE —
to the local zen-unlimited gateway. The provider block is editor-agnostic:
it lives in `opencode.json` / `opencode.jsonc` and works everywhere.

## Prerequisites

The stack must be up on the same machine. Verify first (read-only):

```powershell
curl.exe -s --max-time 10 http://localhost:20128/api/health
# -> 200 {"ok":true}
curl.exe -s --max-time 10 http://localhost:20128/v1/models
# -> 200, ids include oc/muse-spark-1.3-contributor-free
```

If unreachable: `bun run src/index.ts status` (add `--self-heal` to boot
dead services), then `bun run src/index.ts doctor`. Paths below assume the
repo at its checkout root — adjust if yours differs.

## Provider block

Global config: `~/.config/opencode/opencode.json` (or `.jsonc`).
Project override: `./opencode.json` from the worktree root.
Keep `$schema` and every existing key; only merge the `oc` entry into
`provider`. Schema: `https://opencode.ai/config.json` (opencode hard-fails
on unknown keys — when in doubt, fetch the schema, never guess).

```jsonc
"provider": {
  "oc": {
    "name": "OpenCode Free",
    "npm": "@ai-sdk/openai-compatible",
    "api": "http://localhost:20128/v1",
    "options": {
      // Dummy: the gateway is keyless and ignores auth entirely.
      "apiKey": "zen-keyless",
      "timeout": 300000,
      "headerTimeout": 30000,
      "chunkTimeout": 60000
    },
    "models": {
      "muse-spark-1.3-contributor-free": { "name": "Muse Spark 1.3 Free" }
    }
  }
}
```

Notes:

- Model ids are `oc/<id>` in OpenCode, bare `<id>` upstream — the gateway
  strips the prefix. Full live list (the autoparser refreshes it; never
  hard-code elsewhere):
  `http://localhost:20128/dashboard/providers/opencode`.
- spark 1.3 speaks ONLY `/responses`. OpenCode may send it via
  `/v1/chat/completions` — the gateway re-routes by `targetFormat`, so
  both surfaces work. A direct `500 "format must match request format"`
  means the request bypassed the gateway.
- `disabled_providers` must NOT contain `oc`. Leave the user's default
  `model`/`small_model` alone unless asked to switch.
- Secrets rule: no tokens, passwords, or subscription URLs in code, docs,
  tests, or logs. `zen-keyless` above is a placeholder, not a credential.

## Restart + verify

Config loads once at startup — **quit OpenCode fully and restart it**,
then pick `oc/muse-spark-1.3-contributor-free` and send `ping`. Confirm
from the gateway side (no OpenCode restart needed for these):

```powershell
curl.exe -s --max-time 10 "http://localhost:20128/api/usage/proxy-logs?limit=3"
# -> entry with your model, status 200
```

Troubleshooting:

| Symptom | Cause / fix |
|---|---|
| `connection refused` on :20128 | Stack down — `zen status --self-heal`, then `zen doctor` |
| Upstream `Model "" is not supported` | Empty body arrived — on Windows PowerShell, `-d '{...}'` quoting gets mangled; always `curl.exe` (not the `curl` alias) and send JSON via `-d @body.json` file instead |
| `bun`/`node` not found in an elevated shell or scheduled task | PS 5.1 vs pwsh 7 / SYSTEM PATH quirk — user-level tools are not on that PATH; use full tool paths (the scheduler wrappers embed them) |
| HTTP 429 + `zen add-sub` hint | Per-IP free quota exhausted — wait out cooldown, pool rotates on fresh 429s |
| `sing-box check` fails after `add-sub` | Never hand-edit generated outbounds; rerun `zen add-sub <url>` (idempotent, rewires pool) |

## Autostart (Windows)

One file, no manual `schtasks`, no right-click admin dance: run
`scripts/install-zen-stack.ps1` from any PowerShell — it self-elevates
via UAC, imports `oc-singbox` / `oc-relay` / `oc-gateway` (staggered
boot delays PT1M/PT2M/PT3M) plus the `oc-watchdog` PT5M self-heal in a
single XML shot as SYSTEM, resolves bun/node by full path (user PATH is
invisible to SYSTEM), and transcripts to `scripts/install-zen-stack.log`
(instant-close safe). Preview with `-WhatIf`, remove with `-Unregister`.
Verify with `zen doctor` (scheduler check flips to pass). Full matrix:
`docs/e2e-verify-v0.2.0.md`.
