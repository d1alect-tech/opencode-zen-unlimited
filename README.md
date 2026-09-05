# opencode-zen-unlimited

Free `muse-spark` models inside OpenCode through a local gateway, relay pool, and sing-box egress.

[![CI](https://img.shields.io/github/actions/workflow/status/d1alect-tech/opencode-zen-unlimited/ci.yml?branch=main&label=CI)](https://github.com/d1alect-tech/opencode-zen-unlimited/actions)
[![License: MIT](https://img.shields.io/github/license/d1alect-tech/opencode-zen-unlimited)](LICENSE)
[![Bun >= 1.3.14](https://img.shields.io/badge/bun-%3E%3D1.3.14-black?logo=bun)](https://bun.sh)

## What this is

OpenCode talks to a local gateway on port 20128. The gateway fans requests out through a sticky relay pool on port 1090. Six sing-box Hysteria2 egress nodes (ports 1081 to 1086) carry traffic to `opencode.ai/zen`. Per-IP free-tier quota spreads across 6 countries. Zen traffic pins to one egress until a real 429 forces rotation.

## Who it is for

You run Windows on your own PC, you use OpenCode, and you want free Spark models without pasting keys or subscriptions into chats. If you can open PowerShell and copy commands, you can run this.

Non-goals: no Docker, no Linux server setup, no hosted proxy, no key sharing, no static model list (the autoparser refreshes it live).

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quickstart (5 minutes)](#quickstart-5-minutes)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Autostart](#autostart)
- [OpenCode provider](#opencode-provider)
- [Troubleshooting](#troubleshooting)
- [Structure](#structure)
- [Dev](#dev)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Features

- Local gateway on 127.0.0.1:20128 with keyless `oc` provider block.
- Sticky relay on 127.0.0.1:1090, round robin for the rest, 429 watcher with cooldown.
- Six country egresses over Hysteria2 via sing-box (NL, DE, FI, PL, SE, CZ).
- Live free-model autoparser, spark 1.3 pinned to `openai-responses`.
- CLI: setup, add-sub, add-proxy, doctor, status, logs, serve.
- One-file autostart via `scripts/install-zen-stack.ps1` (never raw scheduler XML by hand).
- Loopback only binds, secrets redacted in `doctor` output.

```text
OpenCode (provider "oc" -> http://localhost:20128/v1)
  |
  v
Gateway :20128 (src/gateway/, src/registry/, src/autoparser/)
  |  spark 1.3 served as openai-responses
  |  global proxy -> socks5://127.0.0.1:1090
  v
Relay :1090 (src/relay/, node src/relay/rr-socks.mjs, separate process)
  |  opencode.ai* -> STICKY pin, rotates on fresh 429
  |  rest -> round-robin across pool
  v
sing-box hy2 egresses (src/singbox/, src/sub-converter/)
  :1081 NL | :1082 DE | :1083 FI | :1084 PL | :1085 SE | :1086 CZ
  |
  v
opencode.ai/zen
```

## Requirements

| Need | Minimum | Check |
|---|---|---|
| Windows | 10 22H2 or 11, x64 | `winver` |
| Bun | 1.3.14 (pinned) | `bun --version` |
| Node | 22 LTS (relay fallback) | `node --version` |
| PowerShell | 5.1 or newer | `$PSVersionTable.PSVersion` |
| git | any recent | `git --version` |
| sing-box | 1.14.0, via `scripts/get-singbox.ps1` into `bin/sing-box.exe` | `bin/sing-box.exe version` |

```powershell
winver
```

```text
# -> About Windows dialog: Version 22H2 (or Windows 11), x64.
```

```powershell
bun --version
```

```text
# -> 1.3.14
```

```powershell
node --version
```

```text
# -> v22.x.x
```

```powershell
bin/sing-box.exe version
```

```text
# -> sing-box version 1.14.0
```

Note: the pinned sing-box 1.14 has no `xhttp` transport, so `add-sub` silently drops `xhttp` nodes.

## Quickstart (5 minutes)

Entry is `bun run src/index.ts <cmd>` (short alias: `zen`). `bun run src/index.ts` alone starts the gateway only. The relay is a separate process: `node src/relay/rr-socks.mjs`.

```powershell
git clone https://github.com/d1alect-tech/opencode-zen-unlimited.git
cd opencode-zen-unlimited
```

```text
# -> Cloning into 'opencode-zen-unlimited'... done.
```

```powershell
bun install
```

```text
# -> Lockfile saved. 282 tests pass on a clean tree (0 fail).
```

```powershell
bun run src/index.ts setup --dry-run
```

```text
# -> Plan printed, nothing changed (exit 0). Rerun without --dry-run to write files.
```

```powershell
curl.exe -s --max-time 10 http://localhost:20128/api/health
```

```text
# -> 200 {"ok":true}
```

Start order after reboot is sing-box, then relay, then gateway (autostart staggers PT1M/PT2M/PT3M). Ports are 1081-1086 (egress), 1090 (relay), 20128 (gateway), all loopback only. If Windows Firewall prompts, allow them or add a rule for TCP 20128.

## Installation

Clone, install, preview the plan, then write files. Placeholders only, never real URLs or passwords.

```powershell
git clone https://github.com/d1alect-tech/opencode-zen-unlimited.git
cd opencode-zen-unlimited
bun install
```

```text
# -> Repo cloned, dependencies installed, lockfile saved.
```

```powershell
bun run src/index.ts setup --dry-run
```

```text
# -> Plan printed: writes .env + sing-box/config.json, points at scripts/install-zen-stack.ps1. Nothing changed (exit 0).
```

```powershell
bun run src/index.ts setup
```

```text
# -> Wrote .env and sing-box/config.json. Next: run scripts/install-zen-stack.ps1 for autostart.
```

Fetch sing-box through the pinned script (lands in `bin/sing-box.exe`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/get-singbox.ps1
bin/sing-box.exe version
```

```text
# -> sing-box version 1.14.0
```

## Configuration

Copy `.env.example` to `.env` (gitignored). Every value stays env-only. The sing-box template keeps `YOUR_HY2_PASSWORD` literally: nothing injects `HY2_PASSWORD` into generated outbounds, node passwords come from the subscription link itself.

| Key | What it does | Example |
|---|---|---|
| `PORT` | Gateway bind port (loopback only) | `20128` |
| `EGRESS_UPSTREAMS` | Comma separated egress proxy URLs | `socks5h://127.0.0.1:1081,socks5h://127.0.0.1:1082` |
| `RR_WATCH_TOKEN` | Bearer token for `GET /api/usage/proxy-logs` | `YOUR_RR_WATCH_TOKEN` |
| `RR_WATCH_URL` | Watcher poll target | `http://localhost:20128/api/usage/proxy-logs?limit=20` |
| `RR_WATCH_INTERVAL_MS` | Poll interval | `15000` |
| `RR_COOLDOWN_MS` | Cooldown between rotations | `900000` |
| `EGRESS_SUB_URL` | Subscription URL, env-only secret | `YOUR_SUB_URL` |
| `HY2_PASSWORD` | Placeholder, never injected into outbounds | `YOUR_HY2_PASSWORD` |

## Usage

Entry is `bun run src/index.ts <cmd>` (bin alias `zen`). Flags per command (see `src/cli/parser.ts` USAGE):

```powershell
bun run src/index.ts setup --dry-run
```

```text
# -> Plan printed, change nothing (exit 0).
```

```powershell
bun run src/index.ts add-sub https://example.com/sub --name t9
```

```text
# -> Subscription merged into sing-box config (xhttp nodes dropped on sing-box 1.14).
```

```powershell
bun run src/index.ts add-proxy http://user:pass@proxy.example.com:8080 https://user:pass@proxy.example.com:8443
```

```text
# -> Added 2 proxy URLs to EGRESS_UPSTREAMS (3 total). Reruns dedup, .env.bak backup kept.
```

`add-proxy` is append-only with dedup (reruns add 0, existing entries never rewritten). Exit 0 ok, 2 usage or bad URL, 1 write failure. Node links (`vless:` and friends) stay with `add-sub`.

```powershell
bun run src/index.ts doctor
```

```text
# -> Gateway, relay, egress checks listed, secrets redacted. Exit 1 on any fail.
```

```powershell
bun run src/index.ts doctor --json
```

```text
# -> Machine-readable report object.
```

```powershell
bun run src/index.ts status
```

```text
# -> pidfile liveness for sing-box, relay, gateway.
```

```powershell
bun run src/index.ts status --self-heal
```

```text
# -> Dead procs restarted with a crash toast (exit 0 healed-or-healthy, 1 still down).
```

```powershell
bun run src/index.ts logs gateway --tail 50
```

```text
# -> Last 50 gateway log lines (procs: singbox, relay, gateway; add --follow to stream).
```

```powershell
bun run src/index.ts serve
```

```text
# -> Gateway serving. Refuses with zero egress nodes (exit 1) unless --no-egress-direct (local dev only).
```

## Autostart

One file handles it: `scripts/install-zen-stack.ps1`. It self-elevates via UAC, imports `oc-singbox`, `oc-relay`, `oc-gateway` (staggered PT1M/PT2M/PT3M) plus `oc-watchdog` self-heal, resolves bun and node by full path (SYSTEM has no user PATH), and transcripts to `scripts/install-zen-stack.log`. Never hand-write scheduler XML.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-zen-stack.ps1 -WhatIf
```

```text
# -> WhatIf: lists the four tasks it would import. Nothing changed.
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-zen-stack.ps1
```

```text
# -> UAC prompt, tasks imported as SYSTEM, services started, ports verified.
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-zen-stack.ps1 -Unregister
```

```text
# -> All four tasks removed.
```

Verify after install:

```powershell
bun run src/index.ts doctor
```

```text
# -> Scheduler check flips to pass, all services healthy.
```

If the elevated window closes instantly (PowerRun and friends), read `scripts/install-zen-stack.log`. PS 5.1 vs pwsh 7 PATH quirk: elevated contexts may not see user-level `bun` or `node`, so prefer full tool paths there.

## OpenCode provider

Merge the `oc` block into `opencode.json` (or `opencode.jsonc`), keep `$schema` and every existing key. Full block lives in `docs/agents/configure-oc-provider.md`.

```jsonc
"provider": {
  "oc": {
    "name": "OpenCode Free",
    "npm": "@ai-sdk/openai-compatible",
    "api": "http://localhost:20128/v1",
    "options": {
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

```text
# -> Provider merged keyless (zen-keyless is a placeholder, not a credential). No real keys in the block.
```

Then quit OpenCode fully and restart it (it reads config once at startup). Pick the model and verify:

```powershell
# In OpenCode: /model, pick oc/muse-spark-1.3-contributor-free, send: ping
curl.exe -s --max-time 10 http://localhost:20128/v1/models
```

```text
# -> 200, dual ids per model: oc/<id> plus bare <id> (live list from the autoparser).
```

```powershell
curl.exe -s --max-time 15 --proxy socks5h://127.0.0.1:1090 https://api64.ipify.org
```

```text
# -> An egress IP through the pool (proves relay + sing-box path).
```

```powershell
Set-Content body.json '{"model":"oc/muse-spark-1.3-contributor-free","input":"ping"}'
curl.exe -X POST http://localhost:20128/v1/responses -H "Content-Type: application/json" -d @body.json
```

```text
# -> 200 with model output (not a 500 format error; spark 1.3 speaks ONLY /responses).
```

Always `curl.exe` (not the `curl` alias) and `-d @body.json` (inline `-d '{...}'` quoting gets mangled on Windows PowerShell 5.1).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connection refused` on :20128 | Stack is down: `bun run src/index.ts status --self-heal`, then `doctor`. |
| `Model "" is not supported` | Empty body arrived, the PS 5.1 quoting quirk: use `curl.exe` with `-d @body.json`. |
| `bun`/`node` not found elevated | PS 5.1 vs pwsh 7 PATH quirk, use full tool paths (scheduler wrappers embed them). |
| HTTP 429 on Zen calls | Per-IP free quota spent, pool rotates on fresh 429s after cooldown. Wait or `add-sub` a fresh link. |
| `sing-box check` fails after `add-sub` | Never hand-edit generated outbounds, rerun `zen add-sub <url>` (idempotent). |
| Elevated window closes instantly | Read `scripts/install-zen-stack.log` (UAC transcript lives there). |
| `serve` exits 1 | Zero egress nodes: add some, or pass `--no-egress-direct` for local dev only. |
| `add-proxy` exits 2 | Usage or bad URL, check the scheme and retry. |

## Structure

| Path | What |
|---|---|
| `src/index.ts` | Entry, wires gateway plus CLI (`zen` alias) |
| `src/gateway/` | :20128 request handling |
| `src/registry/` | Provider and model records |
| `src/autoparser/` | Live free-model poller |
| `src/relay/` | :1090 pool plus 429 watcher (`node src/relay/rr-socks.mjs`, separate process) |
| `src/singbox/` | Config emit and process control |
| `src/sub-converter/` | Subscription to egress nodes |
| `src/shared/` | Cross-cutting types, log, env |
| `scripts/install-zen-stack.ps1` | Autostart installer (self-elevates, logs next to itself) |
| `scripts/get-singbox.ps1` | Pinned sing-box fetcher into `bin/` |
| `tests/` | Mirrors `src/`, one file per module |
| `docs/` | Specs and agent guides |

## Dev

Bun-first. TDD is the rule: write the failing test first (`tests/<module>.test.ts`), watch it fail, then write the smallest `src/` change that turns it green.

```powershell
bun install
```

```text
# -> Dependencies installed.
```

```powershell
bun test
```

```text
# -> 282 pass, 0 fail (kept green on every change).
```

```powershell
bun run lint
```

```text
# -> bunx tsc --noEmit clean, no type errors.
```

## Security

Env-only secrets, always. No tokens, passwords, API keys, or subscription URLs in code, docs, tests, or logs. Placeholders (`YOUR_*`, `proxy.example.com`) stand in everywhere. Details and reporting path live in [SECURITY.md](SECURITY.md).

## Contributing

Small focused commits, docs updated in the same commit as the code they describe. Full workflow lives in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
