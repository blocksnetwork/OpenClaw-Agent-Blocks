# Contributing to openclaw-foundation

Thanks for your interest. This repo is a small, hardened **base layer**
for building agents on OpenClaw + Blocks.ai. Keep changes focused and the
offline path green.

## Prerequisites

- **Node.js 22+** (the agent runs TypeScript directly via
  `--experimental-strip-types`; no build step).
- **Docker** (only needed to run the OpenClaw gateway, not for the
  offline smoke).

## Quick start

```bash
git clone https://github.com/blocksnetwork/OpenClaw-Agent-Blocks.git
cd OpenClaw-Agent-Blocks/agent
npm ci
npm run smoke      # offline, no keys, no Docker
```

`npm run smoke` must end with `✅ foundation smoke passed`.

For the gateway and online modes, copy `.env.example` to `.env`, fill in
your keys, and follow [`README.md`](README.md).

## Golden rules

1. **Never commit secrets.** Real keys live in `.env` / `data/secrets/`
   (gitignored). Only `*.example` files carry placeholders. CI and the
   pre-commit hook scan for leaks — see [Secret scanning](#secret-scanning).
2. **Keep the offline smoke green.** `FOUNDATION_OFFLINE=1 npm run smoke`
   must pass after every change. Online behavior is additive.
3. **Preserve public APIs.** Don't change the exported signatures of
   `agent/src/openclaw-client.ts` or `agent/src/blocks-client.ts` without
   updating every caller in the same change.
4. **Keep changes focused.** One logical change at a time; keep the
   offline path green and the public APIs stable.
5. **Don't hand-roll the Blocks transport.** Go through the
   `@blocks-network/sdk` seams (`TaskClient`, `startAgentInstance`,
   `fetchAgentsByTag`, `fetchAgentRegistry`).

## Before opening a pull request

```bash
cd agent
npm run typecheck                 # tsc --noEmit, no errors
FOUNDATION_OFFLINE=1 npm run smoke # ends with ✅ foundation smoke passed
```

- One logical change per PR.
- Use clear commit messages (e.g. `serve agent on Blocks`).
- Update `README.md` if behavior or scope changes.

## Secret scanning

This repo uses [gitleaks](https://github.com/gitleaks/gitleaks) in CI. To
catch secrets *before* they leave your machine, enable the bundled hook:

```bash
git config core.hooksPath .githooks
```

The hook blocks staged `.env` files and obvious API keys.

## Reporting bugs / security issues

- Bugs and features: open a [GitHub issue](https://github.com/blocksnetwork/OpenClaw-Agent-Blocks/issues).
- Security vulnerabilities: **do not** file a public issue — see
  [`SECURITY.md`](SECURITY.md).
