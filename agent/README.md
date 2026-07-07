# Foundation agent

The local half of the foundation: a tiny TypeScript agent that runs an
OpenClaw skill on the gateway and discovers/calls Blocks.ai agents by
skill.

## Run the smoke test

Requires Node 22+ (uses native TypeScript type-stripping — no build).

```bash
cd agent
npm run smoke
# with your own input:
npm run smoke -- "We just shipped real-time collaboration."
```

It runs fully offline by default (`FOUNDATION_OFFLINE=1`) against an
in-process mock catalog, so it works with no API key and no network.

## Layout

`src/` is grouped by domain:

| Folder | Role |
|---|---|
| `src/blocks/` | the ONE door to Blocks.ai (`blocks-client`), the OpenClaw gateway client, and the offline mock catalog |
| `src/a2a/` | agent-to-agent transport, negotiation, budget, and audit |
| `src/assistant/` | the owner-scoped private assistant: runtime, factory, roster, contacts, profile, plan/identity |
| `src/routing/` | turn classification + the canonical intent→tag map (`intent-tags`, `turn-router`) |
| `src/integrations/` | per-owner integrations (calendar/Gmail MCP, OAuth, integration + booking stores) |
| `src/server/` | HTTP surfaces: the chat/dashboard bridge, output serving, authorization |
| `src/pipeline/` | the offline end-to-end flow (`run`), fan-out, and the test suite |
| `src/checks/` | `npm run check:*` offline gates and smoke tests |
| `src/env.ts`, `src/types.ts` | shared root: env loading + types mirroring the Blocks SDK shape |

## Going online

Flip `FOUNDATION_OFFLINE=0` and implement the two `TODO(codex)` seams —
the gateway task API in `openclaw-client.ts` (Phase 2) and the real
Blocks SDK transport in `blocks-client.ts` (Phase 3). The public API of
both modules stays the same, so `run.ts` is untouched. See the top-level
`PLAN.md`.
