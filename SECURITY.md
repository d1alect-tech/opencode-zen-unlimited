# Security Policy

Secrets are env-only, always. Never commit `.env`,
`sing-box/config.json`, or anything under `bin/`.

## Rules

No tokens, passwords, API keys, or subscription URLs in code, docs,
`tests/`, `scripts/`, or logs. Checked-in files use placeholders
(`YOUR_*`, `<fill via env>`) and real values are read from process env
at boot. Curl examples use placeholder tokens only.

No live secrets in GitHub issues either. Redact logs before pasting.

## On leak

Rotate the credential immediately, then purge it from git history
before pushing. Treat any committed secret as compromised.

## Reporting

Report suspected exposures or vulnerabilities via GitHub issues on this
repo. Include what leaked, where, and when. Never include the secret
itself, only its name and the affected path (for example `.env` key
`YOUR_HY2_PASSWORD`).
