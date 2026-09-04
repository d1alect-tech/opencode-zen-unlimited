#!/usr/bin/env bash
# Secrets hygiene gate: fails on real-looking secrets, allows YOUR_* placeholders + example.com fixtures.
# Usage: bash scripts/check-secrets.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
violations=0

scan_assign() {
  local dir="$1"
  [ -e "$dir" ] || return 0
  while IFS= read -r -d '' f; do
    case "$f" in *check-secrets.sh|*check-secrets.ps1) continue;; esac
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno+1))
      case "$line" in *node.*|*process.env*|*decodeURIComponent*|*userinfo*|*===*|*import\ *) continue;; esac
      case "$line" in *YOUR_*) continue;; esac
      if printf '%s' "$line" | grep -Ei -q '(password|passwd|api[_-]?key|secret|RR_WATCH_TOKEN|HY2_PASSWORD|EGRESS_SUB_URL)[[:space:]]*[:=][[:space:]]*["'"'"']?[^"'"'"' ]{8,}'; then
        hit="$(printf '%s' "$line" | grep -Ei -o '(password|passwd|api[_-]?key|secret|RR_WATCH_TOKEN|HY2_PASSWORD|EGRESS_SUB_URL)[[:space:]]*[:=][[:space:]]*["'"'"']?[^"'"'"' ]{8,}' | head -n1)"
        case "$hit" in *example.com*|*YOUR_*) continue;; esac
        echo "  $f:$lineno: $hit"
        violations=$((violations+1))
      fi
    done < "$f"
  done < <(find "$dir" -type f -not -path '*/.git/*' -not -path '*/.scratch/*' -not -path '*/node_modules/*' -print0)
}

for d in "$ROOT/src" "$ROOT/sing-box" "$ROOT/scripts" "$ROOT/docs" "$ROOT/opencode" "$ROOT/README.md" "$ROOT/AGENTS.md"; do
  scan_assign "$d"
done

# Well-known token formats (never placeholders).
while IFS= read -r -d '' f; do
  case "$f" in *check-secrets.sh|*check-secrets.ps1) continue;; esac
  if grep -E -n -q '(sk-ant-|sk-proj-|ghp_[A-Za-z0-9]{8,}|xoxb-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' "$f" 2>/dev/null; then
    grep -E -n '(sk-ant-|sk-proj-|ghp_[A-Za-z0-9]{8,}|xoxb-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' "$f" | sed "s|^|  $f:|"
    violations=$((violations+1))
  fi
done < <(find "$ROOT" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name 'bun.lock' -print0)

# sing-box example must stay placeholder-only.
cfg="$ROOT/sing-box/config.example.json"
if [ -f "$cfg" ]; then
  while IFS= read -r val; do
    case "$val" in YOUR_*|1.1.1.1|cloudflare-dns.com|www.gstatic.com) ;; *) echo "  $cfg: non-placeholder value: $val"; violations=$((violations+1));; esac
  done < <(grep -E -o '"(server|server_name|password)"[[:space:]]*:[[:space:]]*"[^"]+"' "$cfg" | sed -E 's/.*"[a-z_]+"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
fi

if [ "$violations" -gt 0 ]; then
  echo "check-secrets: VIOLATIONS ($violations)"
  exit 1
fi
echo "check-secrets: OK"
