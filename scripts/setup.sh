#!/usr/bin/env bash
# OpenClaw foundation — platform setup.
#
# Brings up the OpenClaw gateway with sane, hardened defaults. Each
# stage is idempotent; re-run a single stage by name.
#
# Usage:  ./scripts/setup.sh [stage]
#   stage = all (default) | prereqs | chown | token | up | status

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '[setup] %s\n' "$*"; }
warn() { printf '[setup] \033[33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '[setup] \033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

env_has_nonempty() { grep -qE "^$1=.+$" .env 2>/dev/null; }

stage_prereqs() {
  bold "[1/5] prereqs"
  command -v docker >/dev/null || die "docker not found on PATH."
  docker info >/dev/null 2>&1 || die "Docker daemon not running. Start Docker Desktop."
  [[ -f .env ]] || { cp .env.example .env && note "created .env from .env.example"; }
  [[ -f docker-compose.yml ]] || die "docker-compose.yml missing."
  mkdir -p data/config data/secrets workspace/skills
  note "Docker is running, files in place."
}

stage_chown() {
  bold "[2/5] chown data/ workspace/ to uid 1000 (container user)"
  local owner
  owner="$(stat -f '%u' data 2>/dev/null || stat -c '%u' data)"
  if [[ "$owner" == "1000" ]]; then
    note "data/ already owned by uid 1000; skipping."
    return
  fi
  note "Running: sudo chown -R 1000:1000 data workspace"
  sudo chown -R 1000:1000 data workspace
}

stage_token() {
  bold "[3/5] OpenClaw gateway token in .env"
  if env_has_nonempty OPENCLAW_GATEWAY_TOKEN; then
    note "OPENCLAW_GATEWAY_TOKEN already set; skipping."
    return
  fi
  local tok
  tok="$(openssl rand -hex 32)"
  if grep -qE '^OPENCLAW_GATEWAY_TOKEN=' .env; then
    sed -i.bak "s|^OPENCLAW_GATEWAY_TOKEN=.*|OPENCLAW_GATEWAY_TOKEN=$tok|" .env
  else
    printf '\nOPENCLAW_GATEWAY_TOKEN=%s\n' "$tok" >> .env
  fi
  rm -f .env.bak
  note "OPENCLAW_GATEWAY_TOKEN generated and written."
  warn "OpenClaw also needs at least one LLM provider key in .env"
  warn "(OPENAI_API_KEY, ANTHROPIC_API_KEY, ...) to answer skill calls."
}

stage_up() {
  bold "[4/5] start openclaw-gateway"
  docker compose pull openclaw-gateway
  docker compose up -d openclaw-gateway
  note "Waiting up to 60s for openclaw-gateway to become healthy..."
  local i status
  for i in $(seq 1 30); do
    status="$(docker inspect -f '{{.State.Health.Status}}' openclaw-gateway 2>/dev/null || echo starting)"
    if [[ "$status" == "healthy" ]]; then
      note "openclaw-gateway healthy. UI: http://127.0.0.1:18789"
      return
    fi
    sleep 2
  done
  warn "openclaw-gateway did not report healthy in 60s."
  warn "Inspect with: docker compose logs openclaw-gateway"
}

stage_status() {
  bold "[5/5] status"
  note "Platform containers:"
  docker compose ps
  note ""
  note "Open the control UI:  http://127.0.0.1:18789"
  note "Paste OPENCLAW_GATEWAY_TOKEN from .env into Settings when prompted."
  note ""
  note "Run the foundation agent smoke test:"
  note "  (cd agent && npm run smoke)"
}

stage="${1:-all}"
case "$stage" in
  prereqs) stage_prereqs ;;
  chown)   stage_chown ;;
  token)   stage_token ;;
  up)      stage_up ;;
  status)  stage_status ;;
  all)
    stage_prereqs
    stage_chown
    stage_token
    stage_up
    stage_status
    ;;
  *) die "Unknown stage: $stage. Stages: prereqs chown token up status all" ;;
esac
