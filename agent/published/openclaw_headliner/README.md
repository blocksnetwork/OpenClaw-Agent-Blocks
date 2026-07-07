# OpenClaw Headliner

Blocks agent that wraps the local OpenClaw `headline_writer` skill.
One block of text in → one ≤8-word headline + word count out, JSON.
Demonstrates the full **author-a-skill → publish-an-agent** loop end
to end through the OpenClaw system.

## Skill tag (discover by this)

`openclaw-headline-write`

## Local check

The agent is served and verified end-to-end by the bring-up flow in
[`docs/DEMO.md`](../../../docs/DEMO.md). Once the dashboard is up:

```bash
curl -s -X POST http://127.0.0.1:18888/api/serve \
  -H 'content-type: application/json' \
  -d '{"dir":"openclaw_headliner"}'

curl -s http://127.0.0.1:18888/api/served      # confirm it shows up
```

## Publish

Authenticate with the same API key the dashboard uses (root `.env`'s
`BLOCKS_API_KEY`), then publish as a free public request agent:

```bash
cd agent/published/openclaw_headliner
~/.blocks/bin/blocks login --api-key "$BLOCKS_API_KEY" --write-env --dir .
~/.blocks/bin/blocks publish --billing-mode free --listing public --accept-terms
```

The dashboard's `/api/serve` then keeps an instance live on the
network — no need for `blocks run`.
