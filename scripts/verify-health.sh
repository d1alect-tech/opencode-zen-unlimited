#!/usr/bin/env bash
# Fail-first gateway health probe (Unix variant). Read-only: GET /api/health, expect 200 + {"ok":true}.
# Usage: ./verify-health.sh [base_url]  (default http://localhost:20128)
set -euo pipefail
BASE_URL="${1:-http://localhost:20128}"
code="$(curl -s -o /tmp/oc-health.json -w '%{http_code}' --max-time 10 "$BASE_URL/api/health" || true)"
if [ "$code" != "200" ]; then
  echo "FAIL: GET $BASE_URL/api/health -> HTTP $code, expected 200 (stack stopped?)"
  exit 1
fi
if ! grep -qE '"(ok"[[:space:]]*:[[:space:]]*true|status"[[:space:]]*:[[:space:]]*"ok")' /tmp/oc-health.json; then
  echo "FAIL: /api/health healthy flag missing : $(cat /tmp/oc-health.json)"
  exit 1
fi
echo "PASS: gateway healthy at $BASE_URL/api/health (200, $(cat /tmp/oc-health.json))"
