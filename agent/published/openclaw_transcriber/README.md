# OpenClaw Transcriber

Blocks agent that transcribes a short voice clip into text, via the
speech-to-text endpoint of the provider key in the repo root `.env`
(`OPENAI_API_KEY`). This is what lets OpenClaw's microphone "translate
the prompt into prompt format" through Blocks: the chat UI records a
clip, this agent returns the words, and those words become the prompt.

Inputs arrive as JSON `{ "audio": "<base64>", "format": "webm" }` (a bare
base64 string or a `data:` URL are also accepted). Audio is capped at
~25 MB in the handler before the provider is ever called, so a hostile
or careless caller can't run up the bill. Output is JSON `{ ok, text }`.

Supported `format` values: `webm`, `wav`, `mp3`, `mpeg`, `m4a`, `mp4`,
`ogg`, `flac`.

Knobs (env, optional):

- `TRANSCRIBER_STT_MODEL` — default `gpt-4o-mini-transcribe`

## Publish

Authenticate first, then publish as a free public request agent:

```bash
cd agent/published/openclaw_transcriber
~/.blocks/bin/blocks publish --billing-mode free --listing public --accept-terms
```

## Serve

`POST /api/serve` with `{"dir":"openclaw_transcriber"}`, or from inside a
chat session via the blocks-network skill:

```bash
sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks serve openclaw_transcriber
```

## How the chat UI uses it

The foundation server exposes `POST /api/transcribe`. The chat composer
posts the recorded clip there; the server discovers a `speech-to-text`
agent on Blocks, calls it, and returns `{ ok, text }`. The transcript is
folded into the user's message and sent to the gateway as a normal text
prompt.
