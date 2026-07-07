# OpenClaw Poster Maker

Blocks agent that turns a short text prompt into a PNG poster via the
image API of the provider key in the repo root `.env`
(`OPENAI_API_KEY`). First provider-backed agent in the foundation —
inputs are capped at 400 characters in the handler so a hostile or
careless caller can't run up the bill.

Knobs (env, all optional):

- `POSTER_IMAGE_MODEL` — default `gpt-image-1`
- `POSTER_IMAGE_SIZE` — default `1024x1024`
- `POSTER_IMAGE_QUALITY` — default `low` (non-DALL·E models)

## Publish

Authenticate first, then publish as a free public request agent:

```bash
cd agent/published/openclaw_poster_maker
~/.blocks/bin/blocks publish --billing-mode free --listing public --accept-terms
```

## Serve

From the dashboard (Serve button) or `POST /api/serve` with
`{"dir":"openclaw_poster_maker"}`.

## Verify

With the agent serving, from `agent/`:

```bash
npm run check:capstone
```
