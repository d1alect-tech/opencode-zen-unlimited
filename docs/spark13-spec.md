# spark13 spec (ported from `omniroute/patch-spark13.py` — spec only)

Source: `C:/Users/Kirill/zen-egress-handoff/omniroute/patch-spark13.py`.
This repo MUST NOT ship, patch, or depend on the omniroute `dist/` bundle.
The logic below is re-expressed as a registry rule in `src/registry/types.ts`.

## Problem

`muse-spark-1.3*` speaks ONLY `/responses`
(`https://opencode.ai/zen/v1/responses` → 200 `Pong!`).
Sent via `/chat/completions`, Zen answers
`500 Internal server error` ("Zen provider format must match request format").

## ANCHOR (upstream omniroute `dist/` entry, minified)

```text
{id:"muse-spark-1.2-contributor-free",name:"Muse Spark 1.2 Contributor Free",supportsReasoning:!0,targetFormat:"openai-responses"}
```

Dry-run rule from the script: walk `DIST` (`argv[1]` > `OMNIROUTE_DIST` env >
default npm-global path), count `.js` files containing ANCHOR
(`files-with-anchor`, `occurrences`). If the anchor is gone after an
`npm i -g omniroute` upgrade, find the new 1.2/1.3 entry and update ANCHOR.
If output says `ALREADY-PATCHED`, nothing to do.

## INSERT (appended after ANCHOR, idempotent)

```text
{id:"muse-spark-1.3",name:"Muse Spark 1.3",supportsReasoning:!0,targetFormat:"openai-responses"},{id:"muse-spark-1.3-contributor-free",name:"Muse Spark 1.3 Contributor Free",supportsReasoning:!0,targetFormat:"openai-responses"}
```

Apply rule: `s.replace(ANCHOR, ANCHOR + "," + INSERT)`; skip files already
containing `INSERT.split(",{")[0]` (the `muse-spark-1.3` id). Report
`DRY` vs `APPLIED` plus `modified` count.

## Registry rule in this repo (no dist patching)

- `resolveTargetFormat(id)`: `muse-spark-*` → `"openai-responses"`, else `"openai-chat"`.
- Precedence: explicit `RegistryModel.targetFormat` > `override` param >
  inbound request shape > prefix default.
- Resolver is format-only, never a membership check: the live free-model
  list comes from the autoparser poller, never a static list.

## FORBIDDEN

- Do NOT vendor, patch, or import the omniroute `dist/` bundle.
- Do NOT implement the `opencode-zen/` apikey path here (keyless `oc/` only).
- Do NOT trust a static free list for membership.
- Do NOT touch `gateway/` / `relay/` / `singbox/` code for this change.
