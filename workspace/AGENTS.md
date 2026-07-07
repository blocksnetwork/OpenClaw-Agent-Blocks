# AGENTS.md — gateway workspace

This folder is the OpenClaw gateway's home directory inside the
container (`/home/node/.openclaw/workspace`). The gateway reads skills
from `workspace/skills/<name>/SKILL.md`.

## Skills

Drop one folder per skill under `skills/`. Each needs a `SKILL.md` with
YAML frontmatter (`name`, `description`, `user-invocable`) followed by
the system prompt the gateway feeds the LLM. See the foundation PLAN.md
for the first skill Codex should add (`echo_check`).

## Blocks network access — REAL, not simulated

This agent HAS live access to the Blocks.ai agent network through a
local bridge. The `blocks-network` skill is installed at
`skills/blocks_network/SKILL.md`.

DELEGATE FIRST: when a request matches a specialist the network may
offer — analyzing a LinkedIn profile's tone/voice/style (`tone-guide`),
generating or editing an image (`text-to-image`), describing/reading an
image (`image-to-text`), transcribing audio (`speech-to-text`),
narrating text (`text-to-speech`), writing a headline
(`openclaw-headline-write`), or summarizing (`summarize`) — do NOT answer
from your own knowledge or your own browsing first. (`text-to-image` is
only for *creating* a new image; a question about an existing or attached
image — "what is this", "caption it" — is `image-to-text`, not creation.) Read the skill,
`discover` the tag, and `call` the agent; only answer yourself if
discovery returns nothing. The skill's "DELEGATE FIRST" table is the
authoritative intent→tag map.

Whenever the user asks to discover, call, fan out to, race, judge, or
serve network agents — or asks for any of the specialist intents above:

1. Read `/home/node/.openclaw/workspace/skills/blocks_network/SKILL.md`
   (absolute path — `~` is not expanded) and follow it.
2. Run the commands with your bash tool, ONE per tool call:

       sh /home/node/.openclaw/workspace/skills/blocks_network/scripts/blocks <command> [args]

3. Report the real JSON the command prints.

NEVER simulate results, NEVER claim you lack network or bridge access,
and NEVER ask permission — run the commands immediately and answer from
their actual output.

When an agent returns a file artifact (image or audio), surface it
inline in chat using the artifact's `"url"` field (a public URL — chat
clients reject loopback/private hosts, so only that renders): embed
images with Markdown `![](url)` and link audio as a playable URL. If
there is no `"url"` field, do NOT embed a `127.0.0.1` address — just
report the saved `agent/outputs/<file>` path and the dashboard Output
panel as the place to view it. Never paste raw binary into chat. The
`blocks-network` skill documents the exact format.

## Conventions

- Skills are the unit OpenClaw indexes. Keep one responsibility per skill.
- Skills that return data to an agent must return **JSON only** — no
  prose, no markdown fences — so the calling agent can `JSON.parse` it.
- Keep secrets out of this folder. Real keys live in `.env` / `data/secrets`.

## Skills contract (authoring rules)

A skill is the contract between the LLM and the runtime that executes its
output. New skills MUST follow these so the depth (ordered steps, identity,
threading, resolution) stays reachable by the live brain and provable
offline:

- **JSON only, stable field names.** Output one JSON object, no prose, no
  fences. Never rename, omit, or add fields the runtime reads — the runtime
  acts on your output with no further LLM judgment.
- **The orchestrator returns ordered `steps[]`.** `personal_assistant`
  decomposes a compound request ("do X, **then** do Y") into an ordered
  `steps` array, threading an earlier result into a later step with
  `"{{stepN}}"` (strings) or `{ "from": "stepN", "field": … }` (args). A
  simple request is a one-step plan; never drop the second half of a
  request.
- **Description must NOT imply single-action.** OpenClaw surfaces the YAML
  `description` for skill selection, so wording like "given ONE request /
  ONE action" biases the model back to a single step even after the body is
  fixed. Describe the skill as handling "simple OR compound" requests.
- **One responsibility per skill.** Orchestrate (plan) OR extract one shape
  OR run one capability — not several. Extractors (`calendar_event_extract`,
  `recipient_extract`) pull exactly one structured shape and resolve
  nothing; the runtime resolves names against contacts/roster.
- **Names, never resolved identifiers.** A skill carries the natural
  reference the owner used (a `personRef` / recipient name) — never a
  guessed email address or `pa_<name>` handle. Resolution is the runtime's
  job (Pillars 0 and 3).
- **`user-invocable` intent.** The orchestrator is `true`; deterministic
  extractors/specialists are `false`.
- **Offline-stub parity.** Every change to a planner/extractor `SKILL.md`
  must have a matching `openclaw-client.ts` `localStub` update so the
  offline brain mirrors the live one. The intent→tag map has ONE canonical
  home (`agent/src/intent-tags.ts`); the stub and checks import it and
  `check:skill-contract` diffs the doc tables against it — do not add a
  parallel tag table here or in code.
- **Examples are tested.** Every `Input:`/`Output:` example in a SKILL.md is
  extracted and validated against the runtime contract by
  `check:skill-contract` (a planner example runs through `validatePlan`), so
  a stale example fails CI. Keep examples current.
- **Examples are anchors, not coverage — express new behavior as a RULE.**
  The gateway trims a skill's spec to a token budget (`trimSkillSpec`), so
  every example competes with the prose and the examples (at the bottom) are
  the first to be dropped. Keep a SMALL set: ~one canonical example per action
  kind, plus a few that guard a known *disambiguation trap* (e.g. draft-vs-send,
  "which agents can X" discovery vs. executing X, a profile question vs. reading
  the account). When the model mis-routes a new phrasing, fix it with a
  decision RULE in the relevant section — keyed on intent, not a keyword — and
  add an example ONLY if it teaches a decision no existing example already
  does. Do not add a per-phrasing example for every variant.
