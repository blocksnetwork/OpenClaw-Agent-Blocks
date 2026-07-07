#!/usr/bin/env bash
# OpenClaw foundation — live calendar integration health check.
#
# Verifies the Google Calendar MCP env points at readable local files, then
# runs the offline-safe live calendar probe. Safe to run after deploying the
# systemd drop-in or when debugging the bridge host.

set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note() { printf '[calendar-doctor] %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

status=0

check_file_env() {
  local name="$1"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    bad "$name is unset"
    status=1
    return
  fi

  if [[ -s "$value" ]]; then
    ok "$name points to a non-empty file"
  else
    bad "$name file is missing or empty"
    status=1
  fi
}

note "Env"
check_file_env GOOGLE_OAUTH_CREDENTIALS
check_file_env GOOGLE_CALENDAR_MCP_TOKEN_PATH

if [[ -z "${PA_CALENDAR_MCP_CMD:-}" ]]; then
  warn "PA_CALENDAR_MCP_CMD is unset; check:calendar-live will skip"
else
  ok "PA_CALENDAR_MCP_CMD is set"
fi

note "Live probe"
if (cd agent && npm run check:calendar-live); then
  ok "calendar-live probe completed"
else
  probe_status=$?
  bad "calendar-live probe failed (exit $probe_status)"
  status=$probe_status
fi

exit "$status"
