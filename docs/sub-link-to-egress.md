# Goal 1, sub link to egress (STUB)

Status: STUB. Pending the sub-converter task. Full content lands with
that task. Do not implement from this stub alone.

## Objective

Turn a subscription URL into sing-box egress outbounds
(`src/sub-converter/` to `src/singbox/`). Input is secret (env-only).
Output is config without secrets committed.

## Pipeline outline

1. **fetch**: GET the subscription URL from env (`YOUR_SUB_URL`),
   with timeout and retry. Never log the URL or body. Keep raw bytes
   in memory only.
2. **detect**: sniff the payload encoding (base64 blob, plain node
   list, or single URI). Branch on content, not on file extension.
3. **parse**: decode entries into normalized node records (scheme,
   host, port, credentials ref, country hint). Drop malformed lines
   with a count, fail loud on zero valid nodes.
4. **emit**: map node records to sing-box outbounds plus :108X
   inbounds. Write through `src/singbox/` config emit. Passwords stay
   as `YOUR_*` placeholders in checked-in examples.

## Contract (planned)

- In: one subscription URL via env, plus target country set
  (default NL/DE/FI/PL/SE/CZ).
- Out: N valid egress outbounds, one per country where possible,
  wired to relay pool ports :1081+.
- Tests first: fixture payloads per encoding in
  `tests/sub-converter.test.ts` (RED to GREEN per `AGENTS.md`).

## Non-goals

No gateway changes, no relay changes, no live subscription URLs in
docs or tests. Placeholders only.
