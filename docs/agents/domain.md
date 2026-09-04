# Domain, single-context layout

One context only. No per-package contexts, no nested agent guides.

## Pointer

There is no root `CONTEXT.md` in this commit. Until one exists, the
project context lives in three files: `README.md` (pipeline, binding,
goals), `AGENTS.md` (commands, TDD, commits, secrets), and `docs/`
(specs per goal). If a root `CONTEXT.md` is added later, it points back
to those files and does not duplicate them.

## Layout rule

- `src/` holds one bounded context: OpenCode to Zen egress. Modules
  (`gateway`, `registry`, `autoparser`, `relay`, `singbox`,
  `sub-converter`, `shared`) are technical partitions, not separate
  domains. Do not give them their own ubiquitous languages.
- `docs/` holds one spec per goal (`docs/sub-link-to-egress.md` for
  Goal 1, more as goals land). `docs/agents/` holds agent guides that
  apply repo-wide.
- `tests/` mirrors `src/` one file per module. Test names use domain
  words: gateway, relay pool, egress, pin, rotation, watcher.
- `.scratch/<feature>/` holds per-feature working state (see
  `docs/agents/issue-tracker.md`). Scratch files never redefine domain
  terms.

## Vocabulary

Use these words consistently in code, tests, and docs:

| Term | Meaning |
|---|---|
| gateway | Local :20128 entry, serves the `oc/` binding |
| relay pool | Sticky SOCKS5 pool on :1090 |
| egress | One outbound country endpoint (:1081-:1086) |
| pin | Zen traffic sticks to one egress until forced off |
| rotation | Pin moves to a new egress after a fresh 429 |
| watcher | 429-watcher, polls usage logs with a cooldown |
| autoparser | Live free-model poller feeding the registry |

If a new term appears, add it here in the same commit that introduces
it.
