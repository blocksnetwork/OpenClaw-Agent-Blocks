/**
 * SKILL.md generation for the "make me a skill file" chat helper: infer a
 * role from the user's phrasing, slugify it into a skill name, and render a
 * ready-to-download SKILL.md. Pure string work, kept out of the router.
 */

export function skillRoleFromText(text: string): string {
  const cleaned = text
    .replace(/\baudio transcript from blocks:\s*/giu, ' ')
    .replace(/\bcan you\b/giu, ' ')
    .replace(/\bplease\b/giu, ' ')
    .replace(/\b(create|make|write|generate|build|need|want|get|give)\b/giu, ' ')
    .replace(/\b(me|my|your|a|an|the|that|i can use|i could use|i need|for my openclaw agent|for my openai agent|inside of my openclaw instance|inside my openclaw instance|in my openclaw instance)\b/giu, ' ')
    .replace(/\b(skills?|skill)\s+files?\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const patterns = [
    /\b(?:need|want|create|make|write|generate|build|get|give)\s+(?:me\s+)?(?:a|an|the)?\s*([^?.!,]+?)\s+skills?\s+files?\b/iu,
    /\bof\s+(?:a|an|the)?\s*([^?.!,]+?)(?:\s+role)?(?:\s+(?:inside|in|for|that|which)\b|[?.!,]|$)/iu,
    /\b(?:as|like)\s+(?:a|an|the)?\s*([^?.!,]+?)(?:\s+role)?(?:\s+(?:inside|in|for|that|which)\b|[?.!,]|$)/iu,
    /\bfor\s+(?:a|an|the)?\s*([^?.!,]+?)(?:\s+role)?(?:\s+(?:inside|in|for|that|which)\b|[?.!,]|$)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const role = normalizeSkillRole(match?.[1] ?? '');
    if (role) return role;
  }
  return normalizeSkillRole(cleaned) || 'custom assistant';
}

function normalizeSkillRole(value: string): string {
  return value
    .replace(/\b(skills?|skill)\s+files?\b/giu, ' ')
    .replace(/\b(role|assistant|agent|my|your)\b/giu, ' ')
    .replace(/\b(openclaw|openai|instance|that i can use|i can use|i could use)\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
}

export function slugifySkillName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 63)
    .replace(/-+$/gu, '');
  return slug || 'custom-assistant';
}

function titleCaseSkill(value: string): string {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function buildSkillFile(args: { role: string; skillName: string }): string {
  const roleTitle = titleCaseSkill(args.role);
  const description = `${roleTitle} support for turning ambiguous goals into practical architecture decisions, options, ADRs, implementation plans, risk reviews, and engineering handoffs. Use when the user needs solution architecture, system design, technical strategy, tradeoff analysis, rollout planning, or architecture review.`;
  return `---
name: ${args.skillName}
description: ${description}
user-invocable: true
---

# ${roleTitle}

Use this skill when the user needs architecture help: clarifying a vague goal,
designing a system, comparing options, writing an ADR, planning a rollout,
reviewing risks, or preparing an engineering handoff.

## Operating Mode

- Start by restating the business goal, users, constraints, and success criteria.
- If critical context is missing, ask up to five focused questions. If the user
  needs momentum, continue with explicit assumptions instead of blocking.
- Prefer practical architecture over perfect architecture. Optimize for the
  user's current scale, team, deadline, budget, and operational maturity.
- Separate facts, assumptions, recommendations, and open questions.
- Make tradeoffs visible. Do not present a single design as inevitable when
  multiple credible paths exist.

## Architecture Workflow

1. Frame the problem:
   - objective
   - stakeholders
   - users and core workflows
   - non-goals
   - constraints and unknowns
2. Map the current state:
   - existing systems
   - integrations and data flows
   - ownership boundaries
   - operational pain points
3. Propose options:
   - at least two viable approaches when the decision is meaningful
   - benefits, costs, risks, reversibility, and migration effort for each
4. Recommend a path:
   - choose one option
   - explain why it fits the current constraints
   - name what would make you revisit the decision
5. Turn the recommendation into execution:
   - milestones
   - interfaces/contracts
   - data model changes
   - rollout and rollback plan
   - observability and success metrics
6. Close with risks and decisions:
   - top risks
   - mitigations
   - open questions
   - decision log or ADR when useful

## Output Formats

Choose the smallest useful format for the request.

### Architecture Brief

Use this for broad design requests:

- Goal
- Context
- Assumptions
- Recommended Architecture
- Key Components
- Data Flow
- Tradeoffs
- Risks
- Rollout Plan
- Open Questions

### Options Comparison

Use this when the user is deciding between approaches:

| Option | Best For | Pros | Cons | Risks | Recommendation |
|---|---|---|---|---|---|

### ADR

Use this for a specific decision:

- Title
- Status
- Context
- Decision
- Consequences
- Alternatives Considered
- Follow-up Work

### Implementation Handoff

Use this when the user needs engineering execution:

- Scope
- Non-goals
- Interfaces
- Tasks
- Migration Plan
- Testing Plan
- Observability
- Rollback
- Owner Checklist

## Review Checklist

Before finalizing, check:

- Does the design satisfy the stated goal?
- Are assumptions explicit?
- Are integration boundaries clear?
- Is the data flow understandable?
- Are security, privacy, reliability, and cost addressed at the right depth?
- Is the rollout incremental and reversible where possible?
- Can an engineer start work from the handoff without another architecture meeting?

## Communication Style

- Be concise, concrete, and direct.
- Use diagrams only when they clarify flow or ownership.
- Use bullets and tables for comparison-heavy answers.
- Call out uncertainty plainly.
- Avoid architecture jargon unless it earns its keep.
`;
}
