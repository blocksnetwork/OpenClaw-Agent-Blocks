# OpenClaw Echo Normalizer

Blocks agent that wraps the local OpenClaw `echo_check` skill.

## Local Check

From the repo root:

```bash
cd agent
npm run check:published
```

## Publish

Authenticate first, then publish as a free public request agent:

```bash
cd agent/published/openclaw_echo_normalizer
~/.blocks/bin/blocks login --write-env
~/.blocks/bin/blocks publish --billing-mode free --listing public --accept-terms
~/.blocks/bin/blocks run
```

For non-interactive auth with a pre-obtained key:

```bash
~/.blocks/bin/blocks login --api-key "$BLOCKS_API_KEY" --write-env --dir .
```

## Verify

Keep `blocks run` alive in one terminal, then from the repo root:

```bash
cd agent
npm run check:own-agent
```
