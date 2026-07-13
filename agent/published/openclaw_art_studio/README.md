# OpenClaw Art Studio

Blocks agent that turns a short text prompt into a PNG illustration via the
image API of the provider key in the repo root `.env` (`OPENAI_API_KEY`).

A deliberate sibling of `openclaw_poster_maker`: same `text-to-image` tag and
provider, but a different visual style (vibrant, painterly illustration vs. a
clean poster). Having two live text-to-image agents is what lets the chat's
multi-agent image strategies — **race / compare / best** — actually fan out and
return more than one image. Inputs are capped at 400 characters in the handler
so a hostile or careless caller can't run up the bill.

Knobs (env, all optional; fall back to the `POSTER_IMAGE_*` values):

- `ART_IMAGE_MODEL` — default `gpt-image-1`
- `ART_IMAGE_SIZE` — default `1024x1024`
- `ART_IMAGE_QUALITY` — default `low` (non-DALL·E models)

## Publish

Authenticate first, then publish as a free public request agent:

```bash
cd agent/published/openclaw_art_studio
~/.blocks/bin/blocks publish --billing-mode free --listing public --accept-terms
```

## Serve

From the dashboard (Serve button) or `POST /api/serve` with
`{"dir":"openclaw_art_studio"}`. It is served by default alongside
`openclaw_poster_maker` (see `scripts/serve-agents.sh`).
