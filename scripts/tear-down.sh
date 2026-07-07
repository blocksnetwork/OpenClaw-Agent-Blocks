#!/usr/bin/env bash
# OpenClaw foundation — one-command EC2 tear-down.
#
# Stops the bridge systemd unit and docker-compose gateway stack. Safe to
# run repeatedly; already-stopped services are treated as success.

set -euo pipefail

cd "$(dirname "$0")/.."

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
note() { printf '[tear-down] %s\n' "$*"; }

BRIDGE_UNIT="${BRIDGE_UNIT:-openclaw-bridge}"
status=0

mark_fail() {
  status=1
  bad "$*"
}

systemctl_cmd() {
  if [[ "$(id -u)" == "0" ]]; then
    systemctl "$@"
  else
    sudo systemctl "$@"
  fi
}

stop_bridge() {
  note "Bridge"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping $BRIDGE_UNIT"
    return
  fi

  if systemctl_cmd stop "$BRIDGE_UNIT" >/dev/null 2>&1; then
    ok "$BRIDGE_UNIT stopped"
  else
    mark_fail "could not stop $BRIDGE_UNIT"
  fi
}

stop_gateway() {
  note "Gateway"
  if docker compose down; then
    ok "docker compose down completed"
  else
    mark_fail "docker compose down failed"
  fi
}

main() {
  stop_bridge
  stop_gateway

  if ((status == 0)); then
    ok "tear-down complete"
  else
    bad "tear-down completed with failures"
  fi
  return "$status"
}

main "$@"
