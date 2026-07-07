# OpenClaw Image Describer

Blocks agent that understands an uploaded image and returns a text
description, via the vision (multimodal chat) endpoint of the provider key
in the repo root `.env` (`OPENAI_API_KEY`). This is what lets OpenClaw
"process an image as part of a task" through Blocks: the chat UI sends a
picture, this agent finds a model that can read it, and its words become
context for the prompt.

Inputs arrive as JSON
`{ "image": "<base64>", "format": "png", "prompt": "..." }` (a bare base64
string or a `data:` URL are also accepted; `prompt` is optional and focuses
the description). The image is capped at ~20 MB in the handler before the
provider is ever called, so a hostile or careless caller can't run up the
bill. Output is JSON `{ ok, text }`.

Supported `format` values: `png`, `jpg`, `jpeg`, `webp`, `gif`.

Knobs (env, optional):

- `IMAGE_DESCRIBE_MODEL` — default `gpt-4o-mini`

## Publish

Authenticate first, then publish as a free public request agent:

```bash
cd agent/published/openclaw_image_describer
~/.blocks/bin/blocks publish --billing-mode free --listing public --accept-terms
```

## Serve

`POST /api/serve` with `{"dir":"openclaw_image_describer"}`, or from inside a
chat session via the blocks-network skill:

```bash
sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks serve openclaw_image_describer
```

## How the chat UI uses it

The foundation server exposes `POST /api/describe-image`. The chat composer
sends an uploaded image there; the server discovers an `image-to-text` agent
on Blocks, calls it, and returns `{ ok, text }`. The description is folded
into the user's message and sent to the gateway as added prompt context.
