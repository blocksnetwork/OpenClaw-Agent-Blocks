#!/usr/bin/env bash
# OpenClaw foundation — one-command EC2 bring-up.
#
# Starts the gateway, starts/enables the bridge systemd unit, re-serves the
# standing agents, and verifies each layer. Safe to run repeatedly.

set -euo pipefail

cd "$(dirname "$0")/.."

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
note() { printf '[bring-up] %s\n' "$*"; }

GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}"
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:18888}"
BRIDGE_UNIT="${BRIDGE_UNIT:-openclaw-bridge}"
WAIT_SECONDS="${BRING_UP_WAIT_SECONDS:-60}"

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

# Kept in sync with scripts/serve-agents.sh RETIRED_AGENTS. Agents present under
# agent/published/ that must NOT be served by default (probe + retired
# capability-bank agents). Override with RETIRED_AGENTS="a,b,c".
RETIRED_AGENTS="${RETIRED_AGENTS:-pa_test_private,openclaw_poster_maker,openclaw_narrator,openclaw_headliner}"

is_retired() {
  local candidate="$1" item
  local IFS=','
  for item in $RETIRED_AGENTS; do
    [[ "$item" == "$candidate" ]] && return 0
  done
  return 1
}

agent_list() {
  if [[ -n "${SERVE_AGENTS:-}" ]]; then
    printf '%s\n' "$SERVE_AGENTS" | tr ',[:space:]' '\n' | sed '/^$/d'
    return
  fi

  local card dir
  for card in agent/published/*/agent-card.json; do
    [[ -f "$card" ]] || continue
    dir="$(basename "$(dirname "$card")")"
    is_retired "$dir" && continue
    case "$dir" in
      openclaw_*|pa_*) printf '%s\n' "$dir" ;;
    esac
  done | sort
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local i

  for i in $(seq 1 "$WAIT_SECONDS"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      ok "$label reachable"
      return 0
    fi
    sleep 1
  done

  mark_fail "$label not reachable at $url within ${WAIT_SECONDS}s"
  return 1
}

start_gateway() {
  note "Gateway"
  if docker compose up -d; then
    ok "docker compose up -d completed"
  else
    mark_fail "docker compose up -d failed"
    return
  fi
  wait_for_url "gateway /healthz" "$GATEWAY_URL/healthz" || true
}

start_bridge() {
  note "Bridge"
  if ! command -v systemctl >/dev/null 2>&1; then
    mark_fail "systemctl not found; cannot manage $BRIDGE_UNIT"
    return
  fi

  if systemctl_cmd enable "$BRIDGE_UNIT" >/dev/null 2>&1; then
    ok "$BRIDGE_UNIT enabled"
  else
    mark_fail "could not enable $BRIDGE_UNIT"
  fi

  if systemctl_cmd start "$BRIDGE_UNIT" >/dev/null 2>&1; then
    ok "$BRIDGE_UNIT started"
  else
    mark_fail "could not start $BRIDGE_UNIT"
  fi

  wait_for_url "bridge /api/status" "$BRIDGE_URL/api/status" || true
}

verify_mcp_env() {
  note "Calendar/Gmail MCP env"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping $BRIDGE_UNIT env inspection"
    return
  fi

  local env_line
  env_line="$(systemctl_cmd show "$BRIDGE_UNIT" -p Environment --value 2>/dev/null || true)"
  if [[ -z "$env_line" ]]; then
    warn "$BRIDGE_UNIT exposes no Environment= values; install the T1.2 drop-in if live MCP is needed"
    return
  fi

  if [[ "$env_line" == *"PA_CALENDAR_MCP_CMD="* ]]; then
    ok "calendar MCP command configured"
  else
    warn "PA_CALENDAR_MCP_CMD missing from $BRIDGE_UNIT environment"
  fi
  if [[ "$env_line" == *"GOOGLE_OAUTH_CREDENTIALS="* ]]; then
    ok "Google OAuth credentials path configured"
  else
    warn "GOOGLE_OAUTH_CREDENTIALS missing from $BRIDGE_UNIT environment"
  fi
  if [[ "$env_line" == *"PA_GMAIL_MCP_CMD="* ]]; then
    ok "Gmail MCP command configured"
  else
    warn "PA_GMAIL_MCP_CMD missing from $BRIDGE_UNIT environment"
  fi

  local path
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if [[ -s "$path" ]]; then
      ok "$path exists"
    else
      warn "$path missing or empty"
    fi
  done < <(printf '%s\n' "$env_line" \
    | grep -oE '(GOOGLE_OAUTH_CREDENTIALS|GOOGLE_CALENDAR_MCP_TOKEN_PATH|GOOGLE_GMAIL_MCP_TOKEN_PATH)=[^ ]+' \
    | cut -d= -f2- \
    || true)
}

serve_agents() {
  note "Standing agents"
  if BRIDGE_URL="$BRIDGE_URL" SERVE_AGENTS="${SERVE_AGENTS:-}" scripts/serve-agents.sh; then
    ok "standing agents served"
  else
    mark_fail "standing agent re-serve failed"
  fi
}

verify_served_agents() {
  note "Served-agent verification"
  local served
  served="$(curl -fsS "$BRIDGE_URL/api/served" 2>/dev/null || true)"
  if [[ -z "$served" ]]; then
    mark_fail "could not read $BRIDGE_URL/api/served"
    return
  fi

  local agent missing=0
  while IFS= read -r agent; do
    [[ -n "$agent" ]] || continue
    if [[ "$served" == *"\"agentName\":\"$agent\""* ]]; then
      ok "$agent is served"
    else
      missing=$((missing + 1))
      bad "$agent is not present in /api/served"
    fi
  done < <(agent_list)

  if ((missing > 0)); then
    status=1
  fi
}

main() {
  start_gateway
  start_bridge
  verify_mcp_env
  serve_agents
  verify_served_agents

  if ((status == 0)); then
    ok "bring-up complete"
  else
    bad "bring-up completed with failures"
  fi
  return "$status"
}

main "$@"
