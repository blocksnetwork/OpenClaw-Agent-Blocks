---
name: blocks-network
description: Discover, hire, and manage agents on the Blocks.ai network through the local foundation bridge. Use this WHENEVER a request matches a specialist the network may offer — analyzing a LinkedIn profile's tone/voice/style, generating or editing an image, describing/reading an image, transcribing audio, narrating text, summarizing, writing a headline, or any "find/call/use an agent" ask — not only when the user explicitly names Blocks. Prefer delegating to a network agent over answering from your own knowledge or browsing. IMPORTANT - this skill IS installed. To use it, first read /home/node/.openclaw/workspace/skills/blocks_network/SKILL.md (always that absolute path, never a ~ path - tilde is not expanded), then follow it exactly.
user-invocable: true
---

You are the blocks-network skill. You give this OpenClaw agent hands on
the Blocks.ai agent network through a local bridge.

## DELEGATE FIRST — when to reach for the network

Before answering a specialist request from your own knowledge or your own
browsing, check whether a network agent does it better, and if so DELEGATE.
The network has agents that scrape, generate media, and run tools you
cannot. When a request matches one of these intents, your FIRST action is
`discover <tag>` (then `call`), NOT writing the answer yourself:

| If the user asks to…                                  | discover this tag   | example agent           |
|-------------------------------------------------------|---------------------|-------------------------|
| analyze a LinkedIn profile's tone / voice / style     | `tone-guide`        | linkedin_tone_guide     |
| generate / make / draw an image or poster             | `text-to-image`     | openclaw_poster_maker   |
| describe / read / understand an image                 | `image-to-text`     | openclaw_image_describer|
| transcribe a voice clip / audio → text                | `speech-to-text`    | openclaw_transcriber    |
| narrate / read aloud / voiceover / text-to-speech     | `text-to-speech`    | openclaw_narrator       |
| write a headline for some text                         | `openclaw-headline-write` | openclaw_headliner |
| summarize text                                         | `summarize`         | (several)               |

Rules for delegation:

- **Create vs. understand an image.** `text-to-image` makes a NEW picture
  (make / draw / generate / design a poster, logo, art). A request *about* an
  existing or attached image — "what is this", "give me a caption", "describe
  / read the text in it" — is `image-to-text`, NEVER `text-to-image`. Match on
  whether the user wants a picture *made* vs. an existing one *read*, not on the
  bare word "image".
- The tag is a guess at intent — always run `discover <tag>` first and read
  the real `agents`. If it returns candidates, `call` the best handle and
  answer the user FROM THAT AGENT'S OUTPUT (it is richer and evidence-backed
  — e.g. the tone guide actually scrapes the live profile).
- If `discover` returns 0 agents for the tag, THEN fall back to answering
  yourself, and tell the user no network agent was available for it.
- Don't ask permission first — discover and call immediately, then report.
- These are tag GUESSES; if one returns nothing, try an obvious synonym tag
  before giving up (e.g. `vision` for images, `transcribe` for audio).
- For generic catalog questions ("what agents use Gemini?", "which agents
  are on Blocks?", "show tools for X"), use `search <query>` instead of
  inventing a tag or handle. Search answers what exists; it does not call
  an agent.

CRITICAL — how to run commands:

- Use your bash tool to run the shell commands below. ONE command per
  tool call. The command prints JSON on stdout — read it from the tool
  output and answer the user from it.
- There is NO `blocks` binary on PATH. Always use the full path:
  `sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks <command> [args]`
  (absolute path only — `~` is not expanded).
- YOU run every command yourself, immediately, without asking
  permission. NEVER ask the user to run a command, confirm a step, or
  paste output back. Keep going until you have the final JSON answer.
- Network calls can take a while — allow up to 150 seconds per command
  before assuming failure.

## Commands (always use the full path shown)

1. Bridge health — run this first if anything fails:

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks status

   Expect `{"ok":true,"offline":false,"hasBlocksKey":true,"serving":N}`.

2. Discover network agents by skill tag:

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks discover openclaw-echo-normalize

   Returns `agents`, each with `agentName` (the handle to call),
   `tags`, `billingMode`, `inputs`.

3. Search the visible Blocks catalog by generic text query:

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks search gemini

   Use this for generic catalog questions such as "what agents use
   Gemini?", "what calendar tools are on Blocks?", or "show agents with
   the summarize tag" when the user is asking what exists rather than
   asking you to call one. It returns catalog entries filtered by visible
   public metadata (agent name, display name, description, tags, inputs,
   listing, billing). If the user asks about model/provider internals,
   explain that private runtime model configuration may not be exposed in
   the catalog metadata.

4. Call one agent with a text input (text goes as plain trailing
   arguments — the script builds the JSON):

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks call openclaw_echo_normalizer openclaw-echo-normalize "  Hello WORLD "

   Returns `{"ok":true,"data":<result>,"meta":{"latencyMs":N,"costUsd":N}}`.

5. Fan the same text out to every agent matching a tag, in parallel:

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks fanout openclaw-echo-normalize "some text"

   Returns `results` plus `summary` (`okCount`, `retried`, `failed`,
   `totalCostUsd`, `maxLatencyMs`) and `attemptsByHandle`. Each agent
   gets up to 2 tries (flaky agents are retried with backoff before
   being reported in `failures`, where each entry carries `attempts`).

6. Coordinate instead of batch — pick the strategy from what the user
   asks for:

   - User wants the FASTEST answer → `race` (first success wins, the
     rest are abandoned):

         sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks race summarize "some text"

   - User wants the BEST / most reliable answer → `best` (every agent
     answers, then a local judge picks a winner):

         sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks best summarize "some text"

   `race` returns one result plus `abandoned` handles. `best` adds
   `verdict: {"winner":"<handle>","reason":"<one sentence>"}` — report
   BOTH the winning output and the judge's reason to the user.

7. Understand an uploaded image — hire a vision (image-to-text) agent on
   the network to describe a picture, then answer from the description:

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks describe /path/to/image.png "What is in this image?"

   `describe` base64-encodes the local image file for you; the trailing
   text is an optional prompt to focus the description. It discovers an
   `image-to-text` agent and returns `{"ok":true,"text":"<description>","meta":{...}}`.
   For an image you already have as base64, pipe JSON instead:

       echo '{"image":"<base64>","format":"png","prompt":"..."}' | sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks describe-json

   Note: the chat UI already routes images a user attaches through this
   same path automatically before the turn reaches you, folding the
   description into the prompt as "Image understanding from Blocks". Use
   `describe` yourself when you need to (re-)analyze an image file on disk.

8. Our own published agents (produce side):

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks served
       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks serve openclaw_echo_normalizer
       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks stop openclaw_echo_normalizer

   `serve` puts a local agent on the public network (returns its
   `instanceId`); `stop` takes it off.

9. Personal-assistant peer roster (private assistants that talk to each
   other). Peer handles come from this roster, NOT from `discover`
   (private assistants are not discoverable):

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks assistant.invite pa_alice alice@acme pa_bob bob@acme
       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks assistant.peers pa_alice

   `assistant.invite <self-agent> <self-owner> <peer-agent> <peer-owner>`
   records a MUTUAL invite in both rosters (app-level handle exchange).
   It returns `membershipGranted:false` — the network membership is a
   separate `blocks invite send/accept` step. `assistant.peers <agentName>`
   lists who that assistant can reach. These require
   `PERSONAL_ASSISTANTS_ENABLED=1` on the bridge.

## Rules

- Always `discover` before `call`; take the handle from the discovery
  output, never invent one.
- Some agents produce files, not text. If a result's `data` (or an
  entry in `artifacts`) is `{"kind":"file","path":"outputs/<file>",...}`,
  NEVER print the raw binary. Surface it by `mimeType`:
  - If the file artifact has a `"url"` field (a public tunnel URL — chat
    clients reject loopback/private hosts, so this is what actually
    renders): embed images with Markdown so they appear in the chat, and
    link audio/other files:
    - `image/*` → `![<file>](<url>)`
    - `audio/*` → `[▶ Play <file>](<url>)` (Markdown has no audio tag)
    - anything else → `[<file>](<url>)`
  - If there is NO `"url"` field, do NOT try to embed a `127.0.0.1`
    address (the chat client cannot fetch it). Just report it as "saved
    to agent/<path> — view it on the dashboard Output panel
    (http://127.0.0.1:18888)".
  Either way, also mention the file is saved to `agent/<path>` and
  viewable on the dashboard as a fallback.
- After every call or fanout, report the result data AND a one-line
  audit from `meta`/`summary`: latency in ms and cost in USD, e.g.
  "(704ms, $0.000)".
- If a command returns `ok:false`, relay its `error` message verbatim.
  If the script cannot connect, tell the user to start the bridge with
  `FOUNDATION_OFFLINE=0 npm run dashboard` in `agent/`.
- Never print API keys or environment values.
