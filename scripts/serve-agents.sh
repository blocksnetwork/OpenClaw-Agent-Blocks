#!/usr/bin/env bash
# OpenClaw foundation — re-serve standing agents through the bridge.
#
# Safe to run repeatedly. The bridge's /api/serve endpoint is idempotent:
# an already-live agent returns ok:true with alreadyServing:true.
#
# Usage:
#   ./scripts/serve-agents.sh
#   SERVE_AGENTS="openclaw_poster_maker,openclaw_narrator" ./scripts/serve-agents.sh
#   ./scripts/serve-agents.sh openclaw_poster_maker pa_alice
#
# Optional standing PA provisioning:
#   data/config/personal-assistants.json   # gitignored
#   PA_ASSISTANTS_CONFIG=/path/to/file ./scripts/serve-agents.sh
#
# Optional per-agent Blocks credentials for multi-account demos:
#   BLOCKS_API_KEY_PA_BOB=<bob account key>
#   or data/secrets/agent-api-keys.json     # gitignored, {"pa_bob":"..."}

set -euo pipefail

cd "$(dirname "$0")/.."

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
note() { printf '[serve-agents] %s\n' "$*"; }

BASE="${BRIDGE_URL:-http://127.0.0.1:18888}"
WAIT_SECONDS="${BRIDGE_WAIT_SECONDS:-15}"
PA_CONFIG="${PA_ASSISTANTS_CONFIG:-data/config/personal-assistants.json}"
NODE_BIN="${NODE_BIN:-node}"

is_agent_name() {
  [[ "$1" =~ ^[a-zA-Z0-9_-]+$ ]]
}

# Agents that live under agent/published/ but must NOT be served by default.
#   pa_test_private            — findability/check probe only
#   openclaw_headliner         — retired capability-bank agent (headline-write)
# openclaw_poster_maker (text-to-image) and openclaw_narrator (text-to-speech)
# are served by default: they are the media-generation agents /api/generate-image
# and blocks_network/SKILL.md discover, so image/audio creation must have a live
# instance to hire (otherwise the hire times out and the turn falls back to the
# gateway). Retired agents can still be served on demand by passing the name
# explicitly or via SERVE_AGENTS=. Override the retired set with
# RETIRED_AGENTS="a,b,c".
RETIRED_AGENTS="${RETIRED_AGENTS:-pa_test_private,openclaw_headliner}"

is_retired() {
  local candidate="$1" item
  local IFS=','
  for item in $RETIRED_AGENTS; do
    [[ "$item" == "$candidate" ]] && return 0
  done
  return 1
}

normalize_agent_list() {
  local raw="$1"
  printf '%s\n' "$raw" | tr ',[:space:]' '\n'
}

default_agents() {
  local card dir name
  for card in agent/published/*/agent-card.json; do
    [[ -f "$card" ]] || continue
    dir="$(basename "$(dirname "$card")")"
    is_retired "$dir" && continue
    case "$dir" in
      openclaw_*|pa_*)
        name="$dir"
        is_agent_name "$name" && printf '%s\n' "$name"
        ;;
    esac
  done | sort
}

collect_agents() {
  if (($# > 0)); then
    printf '%s\n' "$@"
  elif [[ -n "${SERVE_AGENTS:-}" ]]; then
    normalize_agent_list "$SERVE_AGENTS"
  else
    default_agents
  fi
}

has_explicit_agent_selection() {
  (($# > 0)) || [[ -n "${SERVE_AGENTS:-}" ]]
}

provision_personal_assistants() {
  if [[ "${PROVISION_PERSONAL_ASSISTANTS:-1}" == "0" ]]; then
    return 0
  fi
  if [[ -z "${PA_ASSISTANTS_JSON:-}" && ! -f "$PA_CONFIG" ]]; then
    return 0
  fi

  note "Provisioning standing personal assistants"
  BRIDGE_URL="$BASE" PA_ASSISTANTS_CONFIG="$PA_CONFIG" \
    "$NODE_BIN" scripts/provision-personal-assistants.mjs
}

wait_for_bridge() {
  local i body
  note "Waiting for bridge at $BASE/api/status"
  for i in $(seq 1 "$WAIT_SECONDS"); do
    body="$(curl -fsS "$BASE/api/status" 2>/dev/null || true)"
    if [[ "$body" == *'"ok":true'* ]]; then
      ok "bridge is ready"
      return 0
    fi
    sleep 1
  done
  bad "bridge did not become ready within ${WAIT_SECONDS}s at $BASE"
  return 1
}

serve_agent() {
  local agent="$1"
  local body response

  if ! is_agent_name "$agent"; then
    bad "$agent (invalid agent name)"
    return 1
  fi

  body='{"dir":"'"$agent"'"}'
  response="$(curl -fsS -X POST "$BASE/api/serve" \
    -H 'content-type: application/json' \
    -d "$body" 2>&1)" || {
    bad "$agent ($response)"
    return 1
  }

  if [[ "$response" == *'"ok":true'* ]]; then
    if [[ "$response" == *'"alreadyServing":true'* ]]; then
      ok "$agent already served"
    else
      ok "$agent served"
    fi
    return 0
  fi

  bad "$agent (unexpected response: $response)"
  return 1
}

main() {
  local agents=()
  local agent failures=0 total=0

  wait_for_bridge || return 1

  if ! has_explicit_agent_selection "$@"; then
    provision_personal_assistants
  fi

  while IFS= read -r agent; do
    [[ -n "$agent" ]] || continue
    agents+=("$agent")
  done < <(collect_agents "$@")

  if ((${#agents[@]} == 0)); then
    bad "no agents selected; set SERVE_AGENTS or pass agent names"
    return 1
  fi

  note "Serving ${#agents[@]} agent(s): ${agents[*]}"
  for agent in "${agents[@]}"; do
    total=$((total + 1))
    if ! serve_agent "$agent"; then
      failures=$((failures + 1))
    fi
  done

  if ((failures > 0)); then
    bad "served $((total - failures))/$total agent(s); $failures failed"
    return 1
  fi

  ok "served $total/$total agent(s)"
}

main "$@"
