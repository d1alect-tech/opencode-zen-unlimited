# AGENTS.md, opencode-zen-unlimited

Project conventions. Follow these on every change.

## Runtime

Bun-first. Engines: `bun >= 1.3.14`, `node >= 22` fallback.
Path alias: `@/*` maps to `src/*` (see `tsconfig.json`).

## Commands

```powershell
bun install
bun run src/index.ts   # dev entry, same as bun run dev
bun run build          # bun build src/index.ts --outdir dist --target bun
bun test               # same as bun run test
bun run lint           # bunx tsc --noEmit, strict, noEmit
```

Run `bunx tsc --noEmit` before every commit. Keep it clean.

## TypeScript

Strict mode is on (`tsconfig.json`: `strict`,
`noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`,
`noImplicitOverride`, `verbatimModuleSyntax`,
`allowImportingTsExtensions`). Use explicit types at module
boundaries. Prefer `import type` for type-only imports.

## TDD

RED to GREEN is the rule. Write the failing test first
(`tests/<module>.test.ts`), run `bun test` to see it fail, then write
the smallest `src/` change that turns it green. No prod code without a
covering test. One behavior per test, name tests by expected outcome.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`. Example: `docs(init): readme, license, agent scaffolding`.
Small focused commits. Never mix docs and logic in one commit unless
the docs describe that exact logic.

## Secrets

Env-only, always. No tokens, passwords, API keys, or subscription URLs
in code, docs, tests, or logs. Use placeholders in checked-in files
(`YOUR_*`, `<fill via env>`). Real values live in local `.env` files
or process env and are read at boot. Curl examples use placeholder
tokens. If a secret slips into a file, rotate it and purge history
before pushing.

## Structure

- `src/index.ts`: entry, wires gateway plus relay.
- `src/gateway/`: :20128 request handling.
- `src/registry/`: provider and model records.
- `src/autoparser/`: live free-model poller.
- `src/relay/`: :1090 pool plus 429-watcher.
- `src/singbox/`: config emit and process control.
- `src/sub-converter/`: subscription to egress nodes.
- `src/shared/`: cross-cutting types, log, env.
- `tests/`: mirrors `src/` one file per module.
- `docs/`: specs and agent guides.
- `.scratch/<feature>/`: local issue tracking (see
  `docs/agents/issue-tracker.md`).

## Docs

Specs live in `docs/`. Agent guides live in `docs/agents/`. The
Goal-1 instruction stub is `docs/sub-link-to-egress.md`. Keep docs
short, concrete, and tied to real paths. Update docs in the same commit
as the code they describe.
