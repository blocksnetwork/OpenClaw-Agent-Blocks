# OpenClaw Narrator

Blocks agent that reads a short text aloud and returns the narration
as `audio/mpeg`, via the TTS endpoint of the provider key in the repo
root `.env` (`OPENAI_API_KEY`). Inputs are capped at 600 characters in
the handler so a hostile or careless caller can't run up the bill.

Knobs (env, all optional):

- `NARRATOR_TTS_MODEL` — default `gpt-4o-mini-tts`
- `NARRATOR_VOICE` — default `alloy`

## Publish

Authenticate first, then publish as a free public request agent:

```bash
cd agent/published/openclaw_narrator
~/.blocks/bin/blocks publish --billing-mode free --listing public --accept-terms
```

## Serve

From the dashboard (Serve button) or `POST /api/serve` with
`{"dir":"openclaw_narrator"}`.

## Verify

With the agent serving, from `agent/`:

```bash
npm run check:capstone
```
