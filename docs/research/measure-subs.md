# Ticket #2 — Замер выработки текущих двух сабов (offline audit + protocol)

Branch: `research/measure-subs` · Date (UTC): 2026-09-13 · HEAD base: `848ba06` (branch point; cf. master `7105013`)
Method: secrets-free audit only. `SUB_URL` / `EGRESS_SUB_URL` are **absent** from env,
so no live subscription fetch was performed. No URLs, passwords, or tokens in this file.
Skill-tool note: this environment exposes no Skill tool, so the "research skill" step
could not be invoked; the audit below follows the ticket contract directly.

## 1. OBSERVED — live config `sing-box/config.json` (offline parse, no secrets)

- Node outbounds: **10**, all `hysteria2`, all `:443` on `*.scvpn.app`, one shared credential shape.
- Routed via `route.rules` (socks-1081…1086): **6** — swx, sws, pls, ess2, eees, dede.
- **Dangling (in config, no route, not in `auto`/`select`): 4** — datade, cheh, fn, nlp2.
  Effective pool = **6/10**, waste = **40%** of configured nodes.
- `urltest/auto` + `selector/select` reference only the 6 routed tags. The 4 dangling
  nodes get zero traffic (neither pinned Zen nor urltest probes).
- SNI defect (observed): `hysteria2-cheh.scvpn.app-443` has
  `tls.server_name = cheh.scvp.app` (missing `n`) vs `server = cheh.scvpn.app`.
  TLS will fail for it even if routed. It is also dangling, so current impact = none,
  fix = one char when rewiring.
- Dedup check on live config (key `lower(host):port:type`): **no duplicates**.
- Proto mix (observed): **100% hysteria2**. vless/vmess/trojan/ss/hy2 parsing is
  supported by `src/sub-converter/`, but none are present in the live config.
- Geo mix: **ESTIMATED only** from tag prefixes (sw-/sws/pl-/ess/eee/dede/data/che/fn/nlp
  suggest SE/CH/PL/EE/DE/DK/CZ/FI/NL) — NOT verified. Confirm per-egress via protocol §3.
- ASN / egress IP mix: **UNKNOWN** — needs live run (§3). Counts/ASN/geo only, never links.
- Tests: `bun test tests/sub-converter` → **37 pass, 0 fail**
  (doc `docs/sub-link-to-egress.md` still says 27 — stale count, docs-only drift).
- Contracts confirmed in code: `UPSTREAMS` hardcoded 1081–1086 (`src/relay/helpers.ts`,
  `src/relay/rr-socks.mjs`); relay watcher cooldown **15 min** (`COOLDOWN_MS`),
  poll **15 s**, freshness window **90 s**; gateway rotation is primary
  (bench 60 s default + ≤1 s jitter, `Retry-After` honored capped at 300 s,
  `MAX_ATTEMPTS = 5`), relay watcher is fallback. Quota "refill midnight UTC" is a
  **provider-side assumption, not in repo code** — must be confirmed by measurement.
- xhttp handling (current code, `src/cli/commands/add-sub.ts`): xhttp nodes are **kept
  in config but never routed** (`UNSPEAKABLE_TRANSPORTS = {xhttp}` → `isRoutable = false`).
  So "junk xhttp" shows as unrouted tails, not as dropped lines. `ssr://` is hard-rejected.
  Dedup keys: converter `lower(host):port:proto`, add-sub `type/lower(host):port` — same idea.

## 2. ESTIMATED / UNVERIFIED — needs live run, do NOT quote as fact

- Burn time 1–1.5 h per egress IP: **user-reported, unverified** in this audit
  (no traffic logs were available; `SUB_URL` absent).
- `req/IP/day`, `429/IP/hour`: **not observed** — no live data exists on this branch.
  Capacity model until measured: effective pool = 6 → at burn rate B req/IP,
  daily need D req requires `ceil(D / B)` distinct IPs; target ~15 egress (ticket)
  is consistent with ~2.5× current effective pool, but B itself is unmeasured.
- Geo/ASN diversity of the 2 subs (overlap? same AS?): **unknown** — §3 resolves it.

## 3. MEASUREMENT PROTOCOL — user runs with secrets in env only

Rules: links/tokens live in `$env` session-only. Never paste them into files, logs,
or issue comments. Report back counts / ASN / geo / timings only.

```powershell
# 0. Prereqs: bun >= 1.3.14, repo HEAD on branch research/measure-subs
$env:SUB_URL = "<paste subscription link here, session only>"
# For the second sub, repeat steps 1-2 with $env:SUB_URL = "<second link>"

# 1. Fetch + convert to temp files (raw bytes stay in memory, never logged)
Set-Content convert-tmp.ts 'import { convertSubUrl } from "./src/sub-converter/index.ts"; const r = await convertSubUrl(process.env.SUB_URL!); await Bun.write("singbox-tmp.json", JSON.stringify(r.singboxConfig, null, 2)); await Bun.write("relay-tmp.json", JSON.stringify(r.relayUpstreams, null, 2)); console.log(`nodes=${r.outbounds.length} dropped=${r.dropped}`); console.log(JSON.stringify(r.errors.slice(0,5)));'
bun convert-tmp.ts
Remove-Item convert-tmp.ts

# 2. Junk breakdown per sub (counts only — paste THESE numbers into issue #2)
#    nodes= / dropped= from step 1, plus:
#    (a) proto histogram, (b) xhttp count, (c) dup count, (d) host:port overlap vs live config
bun -e 'const c = await Bun.file("singbox-tmp.json").json(); const obs = c.outbounds.filter(o => !["direct","block","selector","urltest"].includes(o.type)); const h = {}; for (const o of obs) h[o.type] = (h[o.type] ?? 0) + 1; console.log("outbounds=" + JSON.stringify(h)); console.log("xhttp=" + obs.filter(o => o?.transport?.type === "xhttp").length);'

# 3. Egress IP + ASN + geo per routed node (proves which IP each 108x burns)
#    Start stack first: sing-box, then relay (node src/relay/rr-socks.mjs), then gateway.
foreach ($p in 1081..1086) { Write-Output ("--- upstream {0} ---" -f $p); curl.exe -s --max-time 15 --proxy socks5h://127.0.0.1:$p https://api64.ipify.org; Write-Output ""; }
# For each printed IP (counts only back to the issue): ASN via https://ipinfo.io/<ip>/json
# in a browser (or `curl https://ipinfo.io/<ip>/json`), record org/country per 108x port.

# 4. Burn-rate watch (the actual ticket Question)
#    Use Zen normally; after each 429 note UTC time + which 108x was pinned
#    (gateway log pin line / relay ATTR_LOG ROTATE line):
$env:RR_ATTR_LOG = "$PWD/attr.log"
#    Then: first-429 UTC per IP, req count to that point (gateway /api/usage/proxy-logs),
#    refill check after 00:00 UTC (does the benched IP serve again?).
#    Report: req/IP/day, 429/IP/hour, burn hours, refill yes/no.
```

## 4. What the map driver needs next

1. User pastes §3 step-2 counts + step-3 ASN/geo table + step-4 burn numbers into issue #2.
2. Rewire the 4 dangling tails (datade/cheh/fn/nlp2) or drop them; fix cheh SNI typo
   (one char) if the node is kept — separate fix ticket, not this research.
3. Refresh stale `27 tests` count in `docs/sub-link-to-egress.md` (now 37).
4. Do NOT close issue #2 from here — closer is the map driver.

