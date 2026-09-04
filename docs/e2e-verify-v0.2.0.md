# E2E verify ledger — v0.2.0 (plan T14)

Date (UTC): 2026-09-04. Machine: Windows 11, bun 1.3.14, node 22.23.2.
HEAD: `eb03e02` (`feat(cli): add-sub command`; chain `340376b` status,
`54ce9f7` watchdog, `db5144c` setup, `eb03e02` add-sub).
All commands run live via `bun run src/index.ts <cmd>`; outputs below are
real, recorded on a machine with **no services running** (no sing-box
binary, no `.env`, no pidfiles, no scheduler tasks).

## Gates

- `bun test`: **221 pass, 0 fail** across 31 files (558 expects).
- `bunx tsc --noEmit`: **clean** (no errors).

## CLI x exit-code matrix

| Command | Exit | Real output (summary) |
|---|---|---|
| `doctor` | **1** | 6 checks failed: `binary:sing-box` not resolvable, `config-env` missing `.env`, `service:sing-box/relay/gateway` pidfile missing or stale, `zen-endpoint` GET /v1/models → HTTP 401. Pass: bun/node/bunx runtimes, `port:1090` + `port:20128` listening (something holds the ports, but no pidfiles — not ours). Warn: EGRESS_UPSTREAMS empty (direct mode), firewall profile OFF, scheduler tasks missing. |
| `doctor --json` (with `EGRESS_SUB_URL=https://example.com/sub?token=SECRET123` in env) | **1** | Same checks as above in `{ok:false,version,platform,checks[]}` shape. **Redaction spot-check PASS**: `SECRET123` appears nowhere in stdout; secret-bearing details render as `[redacted]` via `redactSecrets` (`src/cli/doctor-framework.ts`). |
| `status` | **1** | All three rows `dead` (`pidfile missing or stale`), no pids/uptime. Exit 1 = still-down, correct for a stopped stack. |
| `setup --dry-run` | **0** | Prints plan only (pid/log dirs, sing-box ≥ 1.14.0 check, `.env` skeleton, sing-box config emit, scheduler tasks, next steps `add-sub` → `doctor`). `git status --short` after: only `?? .omo/` — **proof nothing changed**. |
| `logs bogus` | **2** | `error: unknown proc 'bogus'` + usage on stderr. |
| `logs gateway` | **0** | No log dir yet → empty tail, exit 0. |
| `add-sub` (no url) | **2** | `error: missing subscription url` + usage on stderr. |
| `serve` with `EGRESS_UPSTREAMS=''` | **1** | `No egress nodes configured. Run 'zen setup' or 'zen add-sub <url>'. Override for local dev only: --no-egress-direct`. Gate refuses as designed. |
| `serve --no-egress-direct` (override) | n/a | **Not run live**: it would bind :20128 and start serving (forbidden in verify — no services started). Override path is covered by unit tests; see `src/gateway/serve-boot.ts` + `egress-gate.ts`. |
| `--help`, `status --help` | **0** | Global usage + per-command help print, exit 0. |

Exit-code contract (all live-confirmed): 0 ok / healed-or-healthy,
1 degraded-or-refused (doctor fail, status still-down, serve gate),
2 usage error.

## Tray rationale (v1 = status + logs + toast, no tray icon)

`systray2` is abandoned upstream and would add a native dependency for a
fake tray; `node-notifier` delivers OS toasts only (no icon) and stays an
optional lazy `require()` that degrades to a no-op when absent
(`src/process/notify.ts`). Crash visibility therefore ships as
`zen status [--self-heal]` + `zen logs <proc>` + crash toasts, no tray.

## Follow-ups for a live machine (not this one)

Install sing-box ≥ 1.14.0, run `zen setup`, `zen add-sub <url>`, start
services in order (sing-box → relay → gateway), then `zen doctor` should
reach exit 0 and `zen status` should show all alive.
