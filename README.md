# opencode-zen-unlimited

Unlimited free `muse-spark` access for OpenCode through a local pipeline:
OpenCode talks to a local gateway, the gateway fans out through a sticky
relay pool, and sing-box Hysteria2 egress nodes carry traffic to
`opencode.ai/zen`. Per-IP free-tier quota spreads across 6 countries, Zen
traffic pins to one egress until a real 429 forces rotation.

Provenance: ported from `C:/Users/Kirill/zen-egress-handoff/` (OmniRoute +
`rr-socks.mjs` + sing-box, proven live 2026-09-04). This repo is a clean
TypeScript rewrite under `src/`. No handoff code is copied. Docs only in
this commit. Implementation lands per goal below.

## Architecture

```text
OpenCode (provider "oc" -> http://localhost:20128/v1)
  |
  v
Gateway :20128  (src/gateway/, src/registry/, src/autoparser/)
  |  spark 1.3 served as openai-responses
  |  global proxy -> socks5://127.0.0.1:1090
  v
Relay :1090  (src/relay/)
  |  opencode.ai*  -> STICKY pin, rotates on fresh 429
  |  rest          -> round-robin across pool
  |  429-watcher polls usage logs, cooldown between rotations
  v
sing-box hy2 egresses  (src/singbox/, src/sub-converter/)
  :1081 NL | :1082 DE | :1083 FI | :1084 PL | :1085 SE | :1086 CZ
  |
  v
opencode.ai/zen
```

Source layout (real paths in this repo):

| Path | What |
|---|---|
| `src/index.ts` | Entry point (`bun run src/index.ts`) |
| `src/gateway/` | Gateway :20128 (OpenCode binding, request dispatch) |
| `src/registry/` | Provider and model registry |
| `src/autoparser/` | Live free-model poller (never a static list) |
| `src/relay/` | Sticky pool relay :1090 plus 429-watcher |
| `src/singbox/` | sing-box config emit and process control |
| `src/sub-converter/` | Subscription link to egress nodes (Goal 1) |
| `src/shared/` | Shared types, logging, env helpers |
| `tests/` | `bun test` suites, one file per module |

## Binding contract

OpenCode connects through a provider named `oc/` configured at
`/dashboard/providers/opencode`. Keyless only. No API keys in the provider
block.

Model id: `oc/muse-spark-1.3-contributor-free`.

Live free list on 2026-09-04 (9 ids, subject to change, see autoparser
note): `big-pickle`, `muse-spark-1.3-contributor-free`,
`muse-spark-1.2-contributor-free`, `deepseek-v4-flash-free`,
`mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`,
`nemotron-3.5-lightning-free`, `laguna-s-2.1-free`.

Spark 1.3 speaks ONLY `/responses`
(`https://opencode.ai/zen/v1/responses`). Sending it through
`/chat/completions` returns `500 "format must match request format"`.
The gateway must register spark 1.3 ids with `targetFormat:
"openai-responses"`.

## Autoparser note

The free-model list changes. The autoparser (`src/autoparser/`) polls the
live source on an interval and updates the registry. Never hard-code a
static model list in gateway or relay code. Tests may pin a fixture list,
prod code must read from the registry populated by the poller.

## Goals 1-3

- **Goal 1, sub link to egress** (`src/sub-converter/`, spec:
  `docs/sub-link-to-egress.md`): fetch a subscription URL, detect the
  encoding, parse node entries, emit sing-box outbounds. STUB in this
  commit. Full content lands with the sub-converter task.
- **Goal 2, gateway** (`src/gateway/`, `src/registry/`,
  `src/autoparser/`): local gateway on :20128 serving the `oc/` binding,
  model registry with `openai-responses` format pinning for spark 1.3,
  live autoparser refresh.
- **Goal 3, relay plus egress pool** (`src/relay/`, `src/singbox/`):
  sticky SOCKS5 pool on :1090, per-account direct ports :1081-:1086,
  429-watcher rotation with cooldown, sing-box Hysteria2 config.

## Setup

Windows, no docker. Bun-first (`bun >= 1.3.14`, Node >= 22 fallback).

```powershell
bun install
bun run src/index.ts   # dev, gateway :20128 + relay :1090
bun run build          # emits dist/
bun test               # unit + contract suites
bunx tsc --noEmit      # type gate (also: bun run lint)
```

1. Fill env from placeholders (never commit secrets, see AGENTS.md).
2. Start sing-box with generated config (`src/singbox/` output).
3. Start the relay (`src/relay/`, port 1090).
4. Start the gateway (`src/gateway/`, port 20128).
5. Add the `oc/` provider in OpenCode at
   `/dashboard/providers/opencode`, keyless, base URL
   `http://localhost:20128/v1`.
6. Quit OpenCode fully and restart so the provider list reloads.

Start order after reboot: sing-box, relay, gateway, then OpenCode.

CLI flow (`bun run src/index.ts <cmd>`): `zen setup --dry-run` previews
the plan without changing anything, `zen setup` writes `.env` +
`sing-box/config.json` and points at `scripts/install-scheduler.ps1`,
`zen add-sub <url>` merges a subscription link into the sing-box config,
`zen doctor [--json]` reports health (secrets redacted, exit 1 on any
fail), `zen status` shows pidfile liveness (`--self-heal` restarts dead
procs with a crash toast), `zen logs <singbox|relay|gateway>` tails logs.
`zen serve` refuses with zero egress nodes unless `--no-egress-direct`
(local dev only). Full exit-code matrix: `docs/e2e-verify-v0.2.0.md`.

## Verify

Placeholders only. Replace tokens with env values at runtime.

```powershell
curl.exe -s --max-time 10 http://localhost:20128/api/health
# -> 200 {"ok":true} (new gateway shape; the old stack returned {"status":"ok"})
curl.exe -s --max-time 10 http://localhost:20128/v1/models
# -> 200 dual ids per model: oc/<id> + <id> (live list from the autoparser)
curl.exe -s --max-time 15 --proxy socks5h://127.0.0.1:1090 https://api64.ipify.org
curl.exe -X POST http://localhost:20128/v1/responses `
  -H "Content-Type: application/json" `
  -d '{"model":"oc/muse-spark-1.3-contributor-free","input":"ping"}'
```

Expect: gateway health 200 `{"ok":true}`, models 200 with dual ids,
ipify returns an egress IP through the pool, responses call returns
model output (not a 500 format error).

Sticky pin: gateway/relay logs show pinned lines for `opencode.ai*`
traffic. Rotation: a fresh 429 triggers a rotate line with from/to ports
and a cooldown window before the next rotation.

## Conventions

See `AGENTS.md` for bun-first commands, TDD RED to GREEN rule,
conventional commits, and the env-only secrets rule. Issue tracking is
local markdown under `.scratch/<feature>/` (see
`docs/agents/issue-tracker.md`). Single-context layout is described in
`docs/agents/domain.md`.
