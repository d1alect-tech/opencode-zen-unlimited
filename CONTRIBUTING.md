# Contributing

Bun-first. Engines: `bun >= 1.3.14`, `node >= 22` fallback.

```powershell
bun install
bun test               # unit + contract suites
bun run lint           # bunx tsc --noEmit, strict, keep clean
```

Run `bunx tsc --noEmit` before every commit.

## TDD

RED to GREEN is mandatory. Write the failing test first in
`tests/<module>.test.ts`, run `bun test` to see it fail, then make the
smallest `src/` change that turns it green. No prod code without a
covering test. One behavior per test, named by expected outcome.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`. Small focused commits. Never mix docs and logic in one
commit unless the docs describe that exact logic.

## Docs

Update docs in the same commit as the code they describe. Keep them
short, concrete, tied to real paths: `src/`, `tests/`, `scripts/`,
`docs/`. Specs live in `docs/`, agent guides in `docs/agents/`.

## Layout

Entry `src/index.ts` (gateway :20128 plus relay :1090 wiring).
`src/gateway/`, `src/registry/`, `src/autoparser/`, `src/relay/`,
`src/singbox/`, `src/sub-converter/`, `src/shared/`.
Issues tracked in `.scratch/<feature>/`
(see `docs/agents/issue-tracker.md`).
