# OpenClaw Foundation

OpenClaw Foundation is a local agent workspace plus a browser dashboard for
building agents that can talk to OpenClaw, call Blocks agents by capability,
and optionally run a private personal assistant.

The shortest version:

1. Run the OpenClaw gateway in Docker.
2. Run the TypeScript bridge in `agent/`.
3. Open the dashboard at `http://127.0.0.1:18888`.
4. Turn on Blocks auth when you want live specialist agents.

This README is intentionally self-contained so a new developer can clone the
repo and get the system running without private notes.

## What Runs Where

```text
Browser dashboard        http://127.0.0.1:18888
        |
        v
OpenClaw bridge          agent/src/server/dashboard.ts
        |
        +-- OpenClaw gateway    http://127.0.0.1:18789
        +-- Blocks network      live specialist agents, when authenticated
        +-- Local published agents in agent/published/
```

The OpenClaw gateway owns the model/tool runtime. The bridge owns the demo
dashboard, Blocks catalog calls, media routes, personal-assistant routes, and
local specialist serving.

## Prerequisites

- macOS, Linux, or WSL
- Docker Desktop or Docker Engine
- Node.js 22 or newer
- npm
- At least one LLM provider key, usually `OPENAI_API_KEY`
- Optional: a Blocks account for live Blocks catalog calls
- Optional: Google OAuth credentials for Calendar/Gmail assistant reads

Check versions:

```bash
docker --version
node --version
npm --version
```

## Install

Clone and install the Node dependencies:

```bash
git clone https://github.com/blocksnetwork/OpenClaw-Agent-Blocks.git
cd OpenClaw-Agent-Blocks

cd agent
npm ci
cd ..
```

Create your environment file:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```bash
OPENAI_API_KEY=your_provider_key
FOUNDATION_OFFLINE=1
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
```

`OPENCLAW_GATEWAY_TOKEN` can be left blank for now; `./scripts/setup.sh`
will generate it.

## Run The Offline Smoke Test

This proves the repo shape works before Docker, Blocks, or Google are
involved.

```bash
cd agent
FOUNDATION_OFFLINE=1 npm run smoke
```

Expected ending:

```text
foundation smoke passed
```

## Run OpenClaw Gateway

From the repo root:

```bash
./scripts/setup.sh
./scripts/doctor.sh
```

What this does:

- creates `.env` if missing
- generates `OPENCLAW_GATEWAY_TOKEN` if empty
- creates `data/` and `workspace/`
- starts `openclaw-gateway` with Docker Compose
- exposes the gateway only on `127.0.0.1:18789`

Open the native OpenClaw UI:

```text
http://127.0.0.1:18789
```

If the UI asks for a token, copy `OPENCLAW_GATEWAY_TOKEN` from `.env`.

Useful gateway commands:

```bash
docker compose ps
docker compose logs -f openclaw-gateway
docker compose restart openclaw-gateway
docker compose down
```

## Run The OpenClaw Dashboard

In a second terminal:

```bash
cd agent
npm run dashboard
```

Open:

```text
http://127.0.0.1:18888
```

The dashboard serves the front-end and proxies model calls to the OpenClaw
gateway. Your browser should not need the gateway token; the bridge reads it
server-side from `.env`.

Check bridge health:

```bash
curl -s http://127.0.0.1:18888/api/status
```

Expected shape:

```json
{"ok":true,"offline":true,"hasBlocksKey":false}
```

The exact fields may include more data, but `ok:true` is the important part.

## Make Sure The Front-End Points At The Right Bridge

For local development, the dashboard should use the same-origin bridge. In
`agent/web/chat/config.js`, use:

```js
window.OPENCLAW_CONFIG = {
  baseUrl: "",
};
```

If the file points at a hosted URL, local chat may talk to the wrong backend.
You can also fix this in the app:

1. Open `http://127.0.0.1:18888`.
2. Click Settings.
3. Set Base URL to `http://127.0.0.1:18888`, or clear it for same-origin.
4. Start a new chat.

## Go Live With Blocks

Offline mode uses the in-process mock catalog. To call real Blocks agents,
authenticate Blocks and run the bridge in live mode.

Update `.env`:

```bash
FOUNDATION_OFFLINE=0
```

Authenticate — run `blocks login` from the **repo root** (not `agent/`):

```bash
# from the repo root, so the key is written to the .env the bridge reads
npx blocks login --write-env
cd agent && npm run check:blocks-account
```

The bridge reads the repo-root `.env`, not `agent/.env` — `blocks login`
writes `BLOCKS_API_KEY` into the `.env` of the directory you run it in. If you
ran it inside `agent/`, copy that single `BLOCKS_API_KEY=...` line into the
repo-root `.env` before starting the bridge.

Then restart the dashboard bridge:

```bash
npm run dashboard
```

Check status again:

```bash
curl -s http://127.0.0.1:18888/api/status
```

Expected live shape:

```json
{"ok":true,"offline":false,"hasBlocksKey":true}
```

Try a catalog prompt in the dashboard:

```text
Find me Blocks agents that can summarize text.
```

## Run Local Specialist Agents

This repo includes a few published-agent folders under `agent/published/`.
The bridge can serve them to Blocks after they have been published or
registered under your Blocks account.

Common local specialists:

- `openclaw_echo_normalizer`
- `openclaw_poster_maker`
- `openclaw_narrator`
- `openclaw_transcriber`
- `openclaw_image_describer`

Serve them from a second terminal while `npm run dashboard` is running:

```bash
curl -s -X POST http://127.0.0.1:18888/api/serve \
  -H 'content-type: application/json' \
  -d '{"dir":"openclaw_echo_normalizer"}'

curl -s -X POST http://127.0.0.1:18888/api/serve \
  -H 'content-type: application/json' \
  -d '{"dir":"openclaw_poster_maker"}'

curl -s -X POST http://127.0.0.1:18888/api/serve \
  -H 'content-type: application/json' \
  -d '{"dir":"openclaw_transcriber"}'

curl -s -X POST http://127.0.0.1:18888/api/serve \
  -H 'content-type: application/json' \
  -d '{"dir":"openclaw_image_describer"}'
```

List what is running:

```bash
curl -s http://127.0.0.1:18888/api/served
```

Try these in the dashboard:

```text
Make an image of a lighthouse.
```

```text
Transcribe this voice memo and pull out the action items.
```

```text
What is in this image, and what should I fix first?
```

Audio uses `openclaw_transcriber` through the `speech-to-text` capability.
Images use `openclaw_image_describer` through the `image-to-text` capability.

## Publish A Local Specialist Once

If `/api/serve` says an agent is not registered, publish it once under the
Blocks account you authenticated.

Example:

```bash
cd agent/published/openclaw_transcriber
../../node_modules/.bin/blocks publish --billing-mode free --listing public --accept-terms

cd ../openclaw_image_describer
../../node_modules/.bin/blocks publish --billing-mode free --listing public --accept-terms
```

Then restart or re-run the `/api/serve` calls.

## Run The Personal Assistant Demo

The personal assistant is optional. It adds owner-scoped assistant routes,
Google Calendar/Gmail reads, write confirmation flows, and private peer
coordination.

Recommended safe local settings:

```bash
PERSONAL_ASSISTANTS_ENABLED=1
PA_MULTI_TENANT_ASSISTANT=1
PA_BRAIN_LIVE=1
PA_READONLY=1
PA_BOOKING_POLICY=confirm
```

For Google Calendar/Gmail read support, also configure:

```bash
PA_CALENDAR_MCP_CMD=npx
PA_CALENDAR_MCP_ARGS=-y @cocal/google-calendar-mcp
PA_GMAIL_MCP_CMD=npx
PA_GMAIL_MCP_ARGS=-y @klodr/gmail-mcp
GOOGLE_OAUTH_CREDENTIALS=/absolute/path/to/gcp-oauth.keys.json
```

Restart the dashboard, open the app, and click Connect Google.

Try:

```text
What's on my calendar tomorrow?
```

```text
Check my availability next Tuesday afternoon.
```

```text
Anything important in my inbox from Markus?
```

In read-only mode the assistant can look things up, but refuses to send
email, create drafts, or book events.

## Useful Checks

Run these from `agent/`:

```bash
npm run typecheck
FOUNDATION_OFFLINE=1 npm run smoke
FOUNDATION_OFFLINE=1 npm run check:catalog-search
FOUNDATION_OFFLINE=1 npm run check:coordination
FOUNDATION_OFFLINE=1 npm run check:pa-readonly
npm run check:blocks-account
```

Some checks require live keys or a running bridge. If a live check fails,
first verify:

```bash
curl -s http://127.0.0.1:18888/api/status
curl -s http://127.0.0.1:18888/api/served
```

## Troubleshooting

`npm: command not found`

Install Node.js 22 or newer. `nvm install 22 && nvm use 22` is a common
local setup.

Docker gateway is unhealthy

```bash
docker compose logs -f openclaw-gateway
./scripts/doctor.sh
```

Chat fails with connection errors

- Make sure `npm run dashboard` is running in `agent/`.
- Make sure the browser is opened at `http://127.0.0.1:18888`.
- Check `agent/web/chat/config.js`; for local work, `baseUrl` should be `""`.

Blocks catalog returns nothing or selected agents hang

- Run `npx blocks login --write-env`.
- Make sure `BLOCKS_API_KEY` is in the repo-root `.env`.
- Confirm `FOUNDATION_OFFLINE=0`.
- Confirm `/api/status` has `hasBlocksKey:true`.
- Public Blocks agents may be inactive; pick another agent or run one of the
  local specialists above.

Audio or image prompts fail

- Confirm `openclaw_transcriber` or `openclaw_image_describer` appears in
  `/api/served`.
- Confirm `OPENAI_API_KEY` is set in `.env`.
- Try a small audio/image file first.

Google says connected but calendar/Gmail does not work

- Reconnect Google after changing OAuth scopes.
- Confirm `GOOGLE_OAUTH_CREDENTIALS` points at a real server-side file.
- Restart the bridge after changing `.env`.

## Repository Layout

```text
.
├── agent/                 TypeScript bridge, dashboard server, checks
│   ├── published/         local Blocks agents this repo can serve
│   ├── src/               bridge, assistant runtime, Blocks client, checks
│   └── web/chat/          browser dashboard
├── data/                  local runtime data and secrets; gitignored
├── scripts/               setup and health-check scripts
├── workspace/             OpenClaw workspace mounted into the gateway
├── docker-compose.yml     OpenClaw gateway container
└── .env.example           environment template
```

## Security Notes

- Never commit `.env`, Google credentials, Blocks credentials, or runtime data.
- The gateway is published on loopback only: `127.0.0.1:18789`.
- The dashboard bridge is local by default: `127.0.0.1:18888`.
- `data/`, `agent/data/`, secrets, logs, and local docs are ignored.
- Use `PA_READONLY=1` for demos that should not write to Gmail or Calendar.

## License

[MIT](LICENSE)
