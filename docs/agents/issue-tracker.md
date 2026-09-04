# Issue tracker, local markdown convention

Decision is final: local markdown tracker only. Do not ask about it.
Do not create GitHub issues for this project.

## Layout

One directory per feature or goal under `.scratch/`:

```text
.scratch/<feature>/ISSUE.md    # task list, checkboxes, owners
.scratch/<feature>/NOTES.md    # findings, proofs, curl outputs (optional)
.scratch/<feature>/LOGS/       # pasted log excerpts (optional)
```

`<feature>` is lowercase with dashes, for example
`.scratch/sub-link-to-egress/`, `.scratch/gateway/`,
`.scratch/relay-pool/`.

## ISSUE.md workflow

1. Create `.scratch/<feature>/ISSUE.md` with a short goal line, a
   checkbox task list, and a facts section (ports, model ids, file
   paths touched).
2. Work the list top to bottom. Check boxes as each lands with a test.
3. Record verify output (curl status lines, `bun test` tail) in the
   file or in `NOTES.md`. No secrets, placeholders only.
4. Close by noting the commit hash at the top of `ISSUE.md`.

Template:

```markdown
# <feature> (status: open|done, commit: <hash when done>)

Goal: one line.

- [ ] failing test in tests/<module>.test.ts
- [ ] src change in src/<module>/
- [ ] bunx tsc --noEmit clean, bun test green
- [ ] docs updated in same commit

Facts: ports, model ids, paths.
```

## Rules

- `.scratch/` is local working state. It may stay uncommitted.
- Never paste tokens, passwords, API keys, or subscription URLs into
  `.scratch/` files that get committed. Use `YOUR_*` placeholders.
- One feature per directory. If scope grows, split the directory.
- No GitHub issues, no remote boards, no questions about where to
  track. This file is the answer.
