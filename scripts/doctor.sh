#!/usr/bin/env bash
# OpenClaw foundation — health check.
#
# Confirms the gateway is up, reachable, and that the foundation agent
# can reach it. Safe to run any time.

set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note() { printf '[doctor] %s\n' "$*"; }

URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}"

note "Docker"
if docker info >/dev/null 2>&1; then ok "docker daemon running"; else bad "docker daemon not running"; fi

note "Gateway container"
if docker inspect openclaw-gateway >/dev/null 2>&1; then
  state="$(docker inspect -f '{{.State.Health.Status}}' openclaw-gateway 2>/dev/null || echo unknown)"
  ok "openclaw-gateway exists (health: $state)"
else
  bad "openclaw-gateway container not found — run ./scripts/setup.sh"
fi

note "Gateway HTTP"
if curl -fsS "$URL/healthz" >/dev/null 2>&1; then ok "$URL/healthz reachable"; else bad "$URL/healthz not reachable"; fi

note "Env"
[[ -f .env ]] && ok ".env present" || bad ".env missing (copy from .env.example)"
grep -qE '^OPENCLAW_GATEWAY_TOKEN=.+$' .env 2>/dev/null && ok "gateway token set" || bad "OPENCLAW_GATEWAY_TOKEN empty"
grep -qE '^(OPENAI|ANTHROPIC|GOOGLE|GROQ)_API_KEY=.+$' .env 2>/dev/null && ok "an LLM provider key is set" || bad "no LLM provider key set"
