#!/usr/bin/env bash
# Requires sing-box >= 1.14.0.
# NOTE: xhttp / splithttp does NOT exist in sing-box — never spec it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
sing-box check -c "$ROOT/sing-box/config.example.json"
