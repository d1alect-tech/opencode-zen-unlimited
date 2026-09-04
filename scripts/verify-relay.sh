#!/usr/bin/env bash
# Relay egress check (Unix variant). Read-only probes via socks5h://127.0.0.1:1090.
# Passes on >1 distinct IP; single egress is a note (exit 0) unless --require-distinct.
# Usage: ./verify-relay.sh [--probes 6] [--require-distinct]
set -euo pipefail
PROBES=6
REQUIRE_DISTINCT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --probes) PROBES="$2"; shift 2 ;;
    --require-distinct) REQUIRE_DISTINCT=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done
IPS="$(mktemp)"
trap 'rm -f "$IPS"' EXIT
ok=0
for i in $(seq 1 "$PROBES"); do
  ip="$(curl -s --max-time 15 --proxy socks5h://127.0.0.1:1090 https://api64.ipify.org || true)"
  if [ -n "$ip" ]; then echo "$ip" >> "$IPS"; ok=$((ok + 1)); fi
  sleep 0.3
done
uniq="$(sort -u "$IPS" | tr '\n' ',' | sed 's/,$//')"
distinct="$(sort -u "$IPS" | grep -c . || true)"
echo "probes=$PROBES ok=$ok distinct=$distinct ips=$uniq"
if [ "$ok" -eq 0 ]; then
  echo "FAIL: relay :1090 unreachable or all probes timed out"
  exit 1
fi
if [ "$distinct" -gt 1 ]; then
  echo "PASS: distinct egress IPs observed via :1090 ($uniq)"
  exit 0
fi
echo "NOTE: single egress IP only (pool pinned or one account live) — not a failure by itself"
[ "$REQUIRE_DISTINCT" -eq 1 ] && exit 1
exit 0
