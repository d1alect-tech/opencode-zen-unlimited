# Goal 1, sub link to egress (agent instruction)

Status: FULL. Implemented in `src/sub-converter/`, tested in
`tests/sub-converter/` (27 tests). Follow these steps on the user
machine to turn a VPN subscription URL into working egress.

## Objective

Convert one subscription URL (secret, env-only) into two artifacts:

- `singbox.json`: sing-box config fragment with one outbound per node,
  plus `selector`/`urltest` groups with `{all}` expanded and
  `route.final` pinned to the first tag.
- `relay_upstreams.json`: `[{ tag, server, port, proto }]` entries
  matching the relay `UPSTREAMS` contract (`src/relay/helpers.ts`:
  `{ host, port }` plus tag/proto).

## Pipeline (code paths)

1. **fetch** (`src/sub-converter/fetch.ts`): `validateSubUrl()` first —
   only `http(s)`, rejects loopback/private/link-local/metadata
   targets and embedded credentials. Then `fetchSub()`: browser UA,
   `clashmeta` UA fallback, redirects followed, 15 s timeout. Never
   log the URL or body; keep raw bytes in memory only.
2. **detect** (`src/sub-converter/detect.ts`): `detectFormat()` sniffs
   content — `json` (sing-box/clash JSON), `clash-yaml`
   (`proxies:` section), `base64-uri` (decodes to `://` links), else
   `uri-list`. Branch on content, never on extension.
3. **parse** (`src/sub-converter/parsers/`): `parseUri()` dispatches
   by scheme to `vless` / `vmess` (base64 JSON) / `trojan` /
   `ss` (sip002 and legacy base64) / `hysteria2` (`hy2` alias).
   `ssr://` is REJECTED with a clear error (no sing-box mapping).
   Unknown schemes throw. Malformed lines are counted and skipped;
   zero valid nodes fails loud.
4. **normalize** (`src/sub-converter/normalize.ts`): strip `[]`
   brackets, port range-check, hysteria2 `tls.alpn: ["h3"]` default,
   `filterNodes()` (include protos, exclude keywords on tag/host),
   `dedupNodes()` by lowercased `(host, port)` keeping the first,
   `assignTags()` as `{proto}-{host}-{port}` with `-2`/`-3`
   collision suffixes.
5. **emit** (`src/sub-converter/emit.ts` + `index.ts`):
   `nodeToOutbound()` maps each node to its sing-box dict
   (`vless` needs `uuid`; `trojan` needs `password`+`tls`;
   `ss` emits `type: "shadowsocks"` with `method`+`password`;
   `hysteria2` needs `password`+`tls.alpn ["h3"]`).
   `validateOutbound()` checks required keys per type.
   `buildSingboxConfig()` expands `{all}` into selector/urltest
   `outbounds` and `{all-first}` (fallback `direct`) into
   `route.final`. Entry points: `convertSubContent(raw, opts,
   template)` for text, `convertSubUrl(url, opts, template)` for
   fetch+convert.

Parser patterns follow Toperlock/sing-box-subscribe
(`parsers/hysteria2.py`, `vless.py`, `tool.py` fetch/dedup) and
sub2singbox/nichind-singbox2proxy conventions, reimplemented in
strict TypeScript. No Python vendored. sing-box Remote-profile
handling is out of scope (GUI concern).

## Agent runbook (user machine)

```powershell
# 1. Secret comes from env only. Never paste it into docs, tests, or logs.
$env:SUB_URL = "<fill via env>"   # the subscription link, session-only

# 2. Fetch + convert (writes singbox.json + relay_upstreams.json).
#    Fill YOUR_HY2_PASSWORD-style placeholders at runtime from env.
bun -e "import { convertSubUrl } from './src/sub-converter/index.ts'; const r = await convertSubUrl(process.env.SUB_URL!); await Bun.write('singbox.json', JSON.stringify(r.singboxConfig, null, 2)); await Bun.write('relay_upstreams.json', JSON.stringify(r.relayUpstreams, null, 2)); console.log(`nodes=${r.outbounds.length} dropped=${r.dropped}`);"

# 3. Validate the emitted config structurally (required keys per
#    outbound type are checked by validateOutbound(); full
#    `sing-box check -c` runs in CI where sing-box is installed).
sing-box check -c singbox.json

# 4. Fill passwords: replace YOUR_* placeholders with real values
#    from env at start time. Never commit the filled file.

# 5. Start sing-box with the generated config, then relay (:1090),
#    then gateway (:20128), then restart OpenCode (see README).
sing-box run -c singbox.json
```

Country selection: default target set is NL/DE/FI/PL/SE/CZ. Use
`excludeKeywords` (e.g. `["expire", "trial"]`) and `includeProtos`
(e.g. `["hysteria2", "vless"]`) in `ConvertOptions` to narrow the
pool before dedup.

## Verify

```powershell
bun test tests/sub-converter/   # 27 tests green
bunx tsc --noEmit                # no sub-converter errors (pre-existing
                                 # gateway/autoparser errors are out of scope)
```

Fixtures use `example.com` and fake credentials only. No real
subscription URLs or passwords anywhere in the repo.
