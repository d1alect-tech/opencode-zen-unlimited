# security-review (status: open)

Goal: track residual secrets-hygiene risks that hardening could not close without behavior/auth changes.

- [x] audit relay/gateway/sub-converter/singbox/scripts (2026-09-04)
- [x] fix SSRF redirect bypass (manual per-hop validation, tests)
- [x] sing-box/config.example.json placeholder-only (YOUR_HY2_SERVER_*)
- [x] .env.example + check-secrets gate (ps1/sh)
- [ ] F3: authenticate GET /api/usage/proxy-logs (RR_WATCH_TOKEN sent, never verified)
- [ ] F4: loopback-only bind for gateway serve when serve lands (index.ts is stub)

Facts:
- RR_WATCH_TOKEN env-only in src/relay/rr-socks.mjs (Bearer send, no verify in src/gateway/app.ts).
- Relay binds 127.0.0.1:1090; gateway serve not implemented yet (src/index.ts = `export {};`).
- Mitigation now: loopback-only traffic; no key injection; no secret logging; gate green.
- F3/F4 need a follow-up task that IS allowed to add auth/bind behavior (out of scope for chore(security)).

Verify: pwsh scripts/check-secrets.ps1 -> OK; bun test green; bunx tsc --noEmit clean.
