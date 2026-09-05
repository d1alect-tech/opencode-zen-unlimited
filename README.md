# opencode-zen-unlimited

Unlimited free `muse-spark` access for OpenCode through a local gateway, a sticky relay pool, and sing-box Hysteria2 egress nodes.

[![CI](https://img.shields.io/badge/ci-bun%20test-blue)](docs/e2e-verify-v0.2.0.md) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE) [![Bun >=1.3.14](https://img.shields.io/badge/bun-%3E%3D1.3.14-black?logo=bun)](https://bun.sh) [![Node >=22](https://img.shields.io/badge/node-%3E%3D22%20LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org)

## Install with your AI agent

Fastest path: copy the whole block below, paste your subscription link (or proxy list) into the placeholders, and send it to any agent with access to your machine (OpenCode, Claude Code, Cursor). The agent installs and verifies everything; it will ask you for anything missing (link, proxies, UAC approval, OpenCode restart).

```text
Ты разворачиваешь opencode-zen-unlimited — локальный egress-proxy для безлимитных бесплатных моделей OpenCode Zen. Репозиторий: <ПУТЬ_К_РЕПО> (не склонирован — склонируй https://github.com/d1alect-tech/opencode-zen-unlimited и работай в нём).

Мои секреты (считай секретами сессии: держи в env, не пиши в файлы репозитория, не логируй целиком, не показывай в выводе):
- VPN-подписка: <ВСТАВЬ_ССЫЛКУ_ИЛИ_ПУСТО> (пусто — спроси, есть ли купленные прокси, и попроси их списком).
- Купленные прокси: <СПИСОК_ИЛИ_ПУСТО>.

Целевая архитектура: OpenCode → gateway 127.0.0.1:20128 → relay 127.0.0.1:1090 → sing-box egress → https://opencode.ai/zen. Провайдер "oc" (keyless), модель "oc/muse-spark-1.3-contributor-free". Без egress безлимита нет — egress обязателен.

Порядок действий (Windows, PowerShell):
0. Окружение: bun >= 1.3.14 (нет — поставь с bun.sh, переоткрой терминал), node >= 22, sing-box >= 1.14.0 (нет — запусти scripts/get-singbox.ps1). Порты 1081-1086/1090/20128 свободны, бинды только на loopback.
1. В корне: `bun install`, затем `bun run src/index.ts setup --dry-run` (покажи мне план), затем `setup` (пишет .env + sing-box/config.json из примеров).
2. Egress: подписку — через `bun run src/index.ts add-sub <ссылка>`; купленные прокси — через `bun run src/index.ts add-proxy <url>...` (можно несколько раз, с дедупом). Форматы: socks5h://user:pass@host:port или http(s)://user:pass@host:port.
3. Старт строго по порядку: sing-box → relay (`node src/relay/rr-socks.mjs`) → gateway (`bun run src/index.ts serve`). .env читается при старте — после правок перезапускай процессы.
4. Автозапуск: `scripts/install-zen-stack.ps1` (сам повышает права через UAC; если окно гаснет — смотри scripts/install-zen-stack.log). Сначала прогони с `-WhatIf`, покажи мне вывод.
5. Провайдер OpenCode: влей блок `oc` по docs/agents/configure-oc-provider.md в мой opencode.json. Дальше Я САМ выйду из OpenCode, зайду заново и выберу модель — тебе туда не лезть, просто скажи когда.
6. Проверка: `doctor` (fails разбери, варнинги покажи), `curl.exe .../api/health` → {"ok":true}, `/v1/models` → dual ids oc/<id>, POST /v1/responses (тело через файл: Set-Content body.json + curl -d @body.json, файл потом удали) → 200 с текстом модели.

Правила: секреты — только env, никогда в коммит; показывай мне команду и вывод каждого шага; если чего-то не хватает (ссылка, прокси, подтверждение UAC) — спроси меня и жди, не выдумывай. Грабли: bare model id без oc/ → 401; spark только через /responses (шлюз уже учитывает); xhttp-ноды add-sub дропает молча (sing-box 1.14); свежий 429 → авторотация egress.
```

## What, who, and non-goals

**What.** Your OpenCode talks to a gateway on your own PC (`http://localhost:20128/v1`). The gateway sends Zen traffic through a relay pool (`socks5://127.0.0.1:1090`) and out via sing-box Hysteria2 nodes in 6 countries. Per-IP free quota spreads across those nodes, and Zen traffic sticks to one egress until a real 429 forces a rotation.

```text
OpenCode (provider "oc")
  -> Gateway :20128 (spark served as openai-responses)
  -> Relay :1090 (STICKY pin for opencode.ai*, round-robin for the rest)
  -> sing-box hy2 egresses :1081-:1086 (NL DE FI PL SE CZ)
  -> opencode.ai/zen
```

**Who.** You're on a fresh Windows PC with zero context and you want free spark models inside OpenCode. You don't need to know TypeScript, SOCKS, or Hysteria2. Follow Quickstart and you're set in 5 minutes.

**Non-goals.** This isn't a VPN and it doesn't sell proxies. There's no Docker and no Linux or macOS setup path. The free-model list is never hard-coded (the autoparser refreshes it live), and secrets never live in the repo. Details live in `docs/`, this file stays scannable.

## Contents

- [Install with your AI agent](#install-with-your-ai-agent)
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
- [Development](#development)
- [Security and contributing](#security-and-contributing)
- [License](#license)

## Features

- `zen setup` walks you through first-run setup, and `--dry-run` previews the plan without touching anything.
- `zen add-sub` merges a subscription link into the sing-box config (on sing-box 1.14, `xhttp` nodes are dropped silently since that transport doesn't exist there).
- `zen add-proxy` appends purchased HTTP(S) proxy URLs with dedup and a `.bak` backup.
- `zen doctor` reports gateway, relay, and egress health with secrets redacted.
- `zen status` shows process liveness, and `--self-heal` restarts dead ones.
- `zen logs` tails sing-box, relay, or gateway logs.
- `zen serve` starts the gateway and refuses to run with zero egress nodes (exit 1) unless you pass `--no-egress-direct` for local dev.
- Sticky egress pin with 429-watcher rotation and a cooldown between rotations.
- One-file Windows autostart installer plus a watchdog that self-heals every 5 minutes.
- Keyless `oc` provider block for OpenCode with dual model ids (`oc/<id>` plus bare `<id>`).
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
## Requirements

| You need | Minimum | Check it | Notes |
|---|---|---|---|
| Windows 10 22H2 or 11, x64 | `winver` shows 19045+ | Run `winver` from Start | Loopback-only binds, no Docker |
| bun | >=1.3.14 (pinned 1.3.14) | `bun --version` | `bun >= 1.3.14`, see `package.json` engines |
| node | >=22 LTS | `node --version` | Fallback runtime plus the relay process |
| PowerShell | 5.1 or newer | `$PSVersionTable.PSVersion` | Always call `curl.exe`, never the `curl` alias |
| git | any recent | `git --version` | Needed for clone |
| sing-box | >=1.14.0 | `bin\sing-box.exe version` | Fetch via `scripts/get-singbox.ps1` into `bin/sing-box.exe` |

Check what's installed in one shot:

```powershell
bun --version
node --version
$PSVersionTable.PSVersion
.\bin\sing-box.exe version
```

```text
# expected: versions like below (plus winver dialog if you run winver)
1.3.14
v22.x.x
Major  Minor  Build  Revision  (5.1+) or 7.x
sing-box version 1.14.x windows/amd64
```

Grab sing-box if it's missing (lands in `bin/sing-box.exe`):

```powershell
.\scripts\get-singbox.ps1
```

```text
# expected: download progress, then .\bin\sing-box.exe version prints 1.14.x
```

Heads up on shells: PowerShell 5.1 mangles inline `-d '{...}'` JSON quoting, so always send JSON via a file (`curl.exe ... -d @body.json`). Elevated shells, scheduled tasks, and pwsh 7 vs PS 5.1 may not see your user-level `bun` or `node`, so prefer full tool paths there.

## Quickstart (5 minutes)

You already cloned the repo (full steps: [Installation](#installation)). From the repo root:

**1. Install deps:**

```powershell
bun install
```

```text
# expected: lockfile check, then a summary like "xx packages installed"
```

**2. Preview the plan (changes nothing):**

```powershell
bun run src/index.ts setup --dry-run
```

```text
# expected: exit 0 plus a printed plan (.env + sing-box/config.json + autostart hint)
```

**3. Run setup:**

```powershell
bun run src/index.ts setup
```

```text
# expected: writes .env + sing-box/config.json, points at scripts/install-zen-stack.ps1
```

**4. Add your subscription link (placeholder shown, yours comes from env):**

```powershell
bun run src/index.ts add-sub YOUR_SUB_URL
```

```text
# expected: merged node count, e.g. "added N outbounds (M dropped: xhttp unsupported on 1.14)"
```

**5. Start the stack in order (sing-box, then relay, then gateway) and check health:**

```powershell
node src/relay/rr-socks.mjs
bun run src/index.ts serve
curl.exe -s --max-time 10 http://localhost:20128/api/health
```

```text
# expected: {"ok":true} with HTTP 200
```

Note what just ran: `bun run src/index.ts` is the gateway only. The relay is a separate process (`node src/relay/rr-socks.mjs` on :1090). After reboot the order stays sing-box, relay, gateway, then OpenCode.

## Installation

Clone and enter the repo:

```powershell
git clone <your-fork-or-mirror-url> opencode-zen-unlimited
cd opencode-zen-unlimited
```

```text
# expected: fresh checkout, prompt now inside opencode-zen-unlimited\
```

Install dependencies:

```powershell
bun install
```

```text
# expected: "xx packages installed", exit 0
```

Preview setup before it writes anything:

```powershell
bun run src/index.ts setup --dry-run
```

```text
# expected: exit 0, plan only, no files changed
```

Run the real setup (add `--yes` to skip prompts and overwrite):

```powershell
bun run src/index.ts setup
```

```text
# expected: .env + sing-box/config.json written, next step points at scripts/install-zen-stack.ps1
```

Fill `.env` from placeholders afterward (keys: [Configuration](#configuration)). Never commit real values.

## Configuration

Copy `.env.example` to `.env` (gitignored) and fill it in. Placeholders use `YOUR_*` and stay literal in docs and templates.

```powershell
Copy-Item .env.example .env
```

```text
# expected: .env exists, still holding YOUR_* placeholders until you edit it
```

| Key | What it does | Example |
|---|---|---|
| `PORT` | Gateway bind port, loopback only | `20128` |
| `EGRESS_UPSTREAMS` | Comma-separated egress proxy URLs (SOCKS pool plus purchased HTTP(S), managed by `zen add-proxy`) | `socks5h://127.0.0.1:1081,http://user:pass@proxy.example.com:8080` |
| `RR_WATCH_TOKEN` | Bearer token the 429-watcher sends to `GET /api/usage/proxy-logs` | `YOUR_RR_WATCH_TOKEN` (generate: `openssl rand -hex 32`) |
| `RR_WATCH_URL` | Watcher poll target | `http://localhost:20128/api/usage/proxy-logs?limit=20` |
| `RR_WATCH_INTERVAL_MS` | Poll interval | `15000` |
| `RR_COOLDOWN_MS` | Cooldown between rotations | `900000` |
| `EGRESS_SUB_URL` | Your subscription URL, env-only | `YOUR_SUB_URL` |
| `HY2_PASSWORD` | Shared Hy2 placeholder | `YOUR_HY2_PASSWORD` (nothing injects this into generated outbounds, node passwords come from the subscription link itself) |

Empty `EGRESS_UPSTREAMS` means direct connection (tests and dev default). The gateway refuses to serve with zero egress nodes unless you pass `--no-egress-direct` (local dev only, exit 1 otherwise).
## Usage

Every command runs as `bun run src/index.ts <cmd>` (bin `zen` once linked). Full flag help lives in `src/cli/parser.ts`, exit-code matrix in `docs/e2e-verify-v0.2.0.md`.

**setup** — interactive first-run setup (`--dry-run` previews, `--yes` overwrites without prompts):

```powershell
bun run src/index.ts setup --dry-run
bun run src/index.ts setup --yes
```

```text
# expected: plan printed (dry-run, exit 0), then .env + sing-box/config.json written
```

**add-sub** — merge a subscription link (`--name` prefixes outbound tags). `xhttp` nodes drop silently on sing-box 1.14:

```powershell
bun run src/index.ts add-sub YOUR_SUB_URL --name t9
```

```text
# expected: "added N outbounds (M dropped: xhttp unsupported on 1.14)", sing-box config rewired
```

**add-proxy** — append purchased proxy URL(s) with dedup and `.bak` backup. Exit 2 on usage or bad URL, exit 1 on write failure:

```powershell
bun run src/index.ts add-proxy http://user:pass@proxy.example.com:8080 https://user:pass@proxy.example.com:8443
```

```text
# expected: "added 2 proxy URLs to EGRESS_UPSTREAMS (3 total). Next: run `zen doctor`."
```

**doctor** — health report with secrets redacted (exit 1 on any fail). `--json` for machines, `--verbose` adds timings:

```powershell
bun run src/index.ts doctor
bun run src/index.ts doctor --json
```

```text
# expected: per-check pass/fail lines (or a JSON report), exit 0 when all green
```

**status** — pidfile liveness plus health probes. `--self-heal` restarts dead procs (exit 0 healed-or-healthy, 1 still-down), `--verbose` adds last log lines:

```powershell
bun run src/index.ts status
bun run src/index.ts status --self-heal
```

```text
# expected: service rows (singbox/relay/gateway) alive, or restarted lines plus a crash toast
```

**logs** — tail a process log (`singbox`, `relay`, or `gateway`). `--tail N` sets depth (default 50), `--follow` streams:

```powershell
bun run src/index.ts logs gateway --tail 20
```

```text
# expected: last 20 gateway log lines (pinned/rotate lines for opencode.ai* traffic)
```

**serve** — start the gateway. Refuses with zero egress nodes (exit 1) unless `--no-egress-direct` (local dev only):

```powershell
bun run src/index.ts serve
bun run src/index.ts serve --no-egress-direct
```

```text
# expected: gateway listening on 127.0.0.1:PORT, or a refusal naming the empty-egress gate
```

Verify the running stack end to end (placeholders only):

```powershell
curl.exe -s --max-time 10 http://localhost:20128/v1/models
curl.exe -s --max-time 15 --proxy socks5h://127.0.0.1:1090 https://api64.ipify.org
Set-Content body.json '{"model":"oc/muse-spark-1.3-contributor-free","input":"ping"}'
curl.exe -X POST http://localhost:20128/v1/responses -H "Content-Type: application/json" -d @body.json
```

```text
# expected: 200 with dual ids per model (oc/<id> + <id>), an egress IP from ipify,
# and model output from /v1/responses (HTTP 200, never the 500 format error)
```

Spark 1.3 speaks ONLY `/responses`. Sending it via `/chat/completions` returns `500 "format must match request format"`, so the gateway pins spark ids to `openai-responses` (spec: `docs/spark13-spec.md`).

## Autostart

One file owns autostart: `scripts/install-zen-stack.ps1` (not the old scheduler split). It self-elevates through UAC, imports `oc-singbox`, `oc-relay`, `oc-gateway` with staggered boot delays (PT1M, PT2M, PT3M) plus the `oc-watchdog` PT5M self-heal in a single shot as SYSTEM, resolves bun and node by full path (SYSTEM has no user PATH), and writes a transcript to `scripts/install-zen-stack.log`.

Preview without changing anything (no elevation needed):

```powershell
.\scripts\install-zen-stack.ps1 -WhatIf
```

```text
# expected: WhatIf lines per task (oc-singbox/oc-relay/oc-gateway/oc-watchdog), nothing registered
```

Install (approve the UAC prompt, then check the log since the elevated window may close instantly under PowerRun):

```powershell
.\scripts\install-zen-stack.ps1
Get-Content .\scripts\install-zen-stack.log -Tail 20
```

```text
# expected: four tasks registered and started, log shows elevated=true plus per-task starts
```

Remove all four tasks:

```powershell
.\scripts\install-zen-stack.ps1 -Unregister
```

```text
# expected: four deletions confirmed, exit 0
```

Confirm the scheduler path works by running `zen doctor` (its scheduler check flips to pass). Ports stay loopback-only: sing-box SOCKS 1081-1086, relay 1090, gateway 20128. If Defender Firewall prompts, allow the loopback listeners:

```powershell
netsh advfirewall firewall add rule name="zen-gateway" dir=in action=allow protocol=TCP localport=20128
```

```text
# expected: "Ok." (rule added)
```

## OpenCode provider

Merge the `oc` block into your OpenCode config (global `~/.config/opencode/opencode.json`, or project `./opencode.json`). Keep `$schema` and every existing key, only add the `oc` entry. Schema: `https://opencode.ai/config.json`. Full guide: `docs/agents/configure-oc-provider.md`.

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

Config loads once at startup, so quit OpenCode FULLY and restart it, then pick `oc/muse-spark-1.3-contributor-free` and send `ping`. Confirm from the gateway side:

```powershell
curl.exe -s --max-time 10 http://localhost:20128/api/health
curl.exe -s --max-time 10 "http://localhost:20128/api/usage/proxy-logs?limit=3"
```

```text
# expected: {"ok":true}, then a usage entry with your model and status 200
```

The dashboard views (`/dashboard/providers/opencode` HTML, `/api/dashboard/providers/opencode` JSON) are read-only inspection, not configuration. Never put real keys in the provider block: `zen-keyless` above is a placeholder, not a credential.
## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `connection refused` on :20128 | Stack is down. Run `zen status --self-heal`, then `zen doctor`. |
| `Model "" is not supported` from upstream | Empty body arrived. On PowerShell, `-d '{...}'` quoting gets mangled: always use `curl.exe` (not the `curl` alias) and send JSON via `-d @body.json`. |
| `bun` or `node` not found in an elevated shell or task | PS 5.1 vs pwsh 7 / SYSTEM PATH quirk: user-level tools aren't on that PATH. Use full tool paths (the installer embeds them). |
| HTTP 429 plus an `add-sub` hint | Per-IP free quota is exhausted. Wait out the cooldown, the pool rotates on fresh 429s. |
| `sing-box check` fails after `add-sub` | Never hand-edit generated outbounds. Rerun `zen add-sub <url>` (idempotent, rewires the pool). |
| `xhttp` nodes vanish after merge | Expected on sing-box 1.14: no `xhttp` transport exists there, so those nodes drop silently. |
| `zen serve` refuses to start | Zero egress nodes. Add some via `add-sub`/`add-proxy`, or pass `--no-egress-direct` for local dev only (exit 1 otherwise). |
| `zen add-proxy` exits 2 | Usage or bad URL. Check the scheme (`socks5/http/https/...`) and retry. Node links (`vless:` etc.) belong to `zen add-sub`. |
| Elevated installer window closes instantly | Read `scripts/install-zen-stack.log`: the transcript keeps the full error. |
| Firewall prompt on first start | Allow the loopback listeners, or add the `netsh` rule from [Autostart](#autostart). Ports: 1081-1086 sing-box, 1090 relay, 20128 gateway. |

## Structure

| Path | What |
|---|---|
| `src/index.ts` | Entry (`bun run src/index.ts <cmd>`, bin `zen`) |
| `src/cli/` | Argument parsing (`parser.ts` owns the USAGE text and flags) |
| `src/gateway/` | Gateway :20128 (OpenCode binding, request dispatch) |
| `src/registry/` | Provider and model registry |
| `src/autoparser/` | Live free-model poller (never a static list) |
| `src/relay/` | Sticky pool relay :1090 plus 429-watcher (`rr-socks.mjs` runs separately) |
| `src/singbox/` | sing-box config emit and process control |
| `src/sub-converter/` | Subscription link to egress nodes (spec: `docs/sub-link-to-egress.md`) |
| `src/shared/` | Shared types, logging, env helpers |
| `scripts/` | `get-singbox.ps1`, `install-zen-stack.ps1`, `check-secrets.ps1`, verifiers |
| `tests/` | `bun test` suites, one file per module |
| `docs/` | Specs (`sub-link-to-egress.md`, `spark13-spec.md`, `e2e-verify-v0.2.0.md`) and agent guides under `docs/agents/` |

## Development

Bun-first. Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, type-only imports via `import type`). TDD is the rule: write the failing test first (`tests/<module>.test.ts`), watch `bun test` fail, then write the smallest `src/` change that turns it green.

```powershell
bun install
bun test
bun run lint
```

```text
# expected: deps installed; suites green (prior: 282 pass, 0 fail); tsc clean, exit 0
```

Run `bunx tsc --noEmit` before every commit and keep it clean. Small focused commits with conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`). Never commit secrets:Scan with `scripts/check-secrets.ps1` first.

```powershell
.\scripts\check-secrets.ps1
```

```text
# expected: no live secrets flagged, exit 0
```

## Security and contributing

- Security policy and how to report issues: [SECURITY.md](SECURITY.md).
- How to contribute (workflow, TDD, commit style): [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
