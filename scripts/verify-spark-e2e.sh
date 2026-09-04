#!/usr/bin/env bash
# OPTIONAL / live upstream call (Unix variant). POST /v1/responses, expect HTTP 200, non-500 body.
# Hits real opencode.ai/zen quota — run sparingly.
# Usage: ./verify-spark-e2e.sh [base_url]  (default http://localhost:20128)
set -euo pipefail
BASE_URL="${1:-http://localhost:20128}"
echo "NOTE: OPTIONAL/live — consumes real upstream quota via /v1/responses."
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
code="$(curl -s -o "$OUT" -w '%{http_code}' --max-time 60 -X POST "$BASE_URL/v1/responses" \
  -H 'Content-Type: application/json' \
  -d '{"model":"oc/muse-spark-1.3-contributor-free","input":"ping"}' || true)"
body="$(cat "$OUT")"
if [ "$code" != "200" ]; then
  echo "FAIL: POST $BASE_URL/v1/responses -> HTTP $code, expected 200. body: $body"
  exit 1
fi
if [ -z "$body" ] || echo "$body" | grep -qiE '"error"|format must match request format'; then
  echo "FAIL: upstream returned error/format-mismatch body: $body"
  exit 1
fi
echo "PASS: spark e2e 200 via $BASE_URL/v1/responses (${#body} chars)"
