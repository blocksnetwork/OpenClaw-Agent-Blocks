/**
 * assistant-dashboard — the PA-5 per-assistant overview aggregator
 * (docs/PERSONAL-ASSISTANT-PLAN.md → "Phase 5 — dashboard surface").
 *
 * Builds the data behind "a panel per assistant: owner, peers, today's
 * spend, and an audit of A2A hops" by JOINING the existing sources — it
 * adds NO new state of its own (no dup logic):
 *
 *   - peers + owner   ← the invite roster      (assistant-roster.ts)
 *   - today's spend   ← the daily A2A budget   (a2a-budget.ts)
 *   - A2A-hop audit   ← the hop trail          (a2a-audit.ts)
 *   - live + uptime   ← the dashboard's served-handle map (passed in)
 *
 * Pure and offline: only reads the local roster/budget/audit files plus the
 * served map the caller hands in.
 */

import { listRosters, type Peer } from './assistant-roster.ts';
import { a2aCallsToday, dailyCap } from '../a2a/a2a-budget.ts';
import { readHops, type A2AHop } from '../a2a/a2a-audit.ts';

/** What the dashboard already knows about a live instance (its served-handle
 *  map), narrowed to the fields the overview needs. */
export interface ServedInfo {
  agentName: string;
  instanceId?: string;
  startedAt?: number;
}

export interface AssistantPanel {
  agentName: string;
  owner: string;
  live: boolean;
  instanceId?: string;
  uptimeMs?: number;
  peers: Array<Pick<Peer, 'agentName' | 'owner' | 'since' | 'sharePolicy' | 'displayName' | 'ownerName' | 'aliases' | 'capabilities'>>;
  peerCount: number;
  /** Today's A2A "spend": outbound calls made vs. the daily cap. */
  spendToday: { a2aCalls: number; dailyCap: number };
  /** Recent A2A hops involving this assistant (newest first). */
  hops: A2AHop[];
}

export interface AssistantOverview {
  ok: true;
  action: 'assistant-overview';
  generatedAt: number;
  dailyCap: number;
  a2aCallsToday: number;
  assistants: AssistantPanel[];
}

export interface OverviewOptions {
  /** The dashboard's live served-handle map (so the panel is "no dup logic"). */
  served?: ServedInfo[];
  /** Override store locations (tests pass temp dirs). */
  rosterBaseDir?: string;
  budgetBaseDir?: string;
  auditBaseDir?: string;
  /** Cap on hops surfaced per assistant (newest first). */
  hopLimit?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Assemble one panel per assistant that has a roster on disk (plus any live
 * served instance), joining roster + budget + audit + the served map.
 */
export async function assistantOverview(opts: OverviewOptions = {}): Promise<AssistantOverview> {
  const env = opts.env ?? process.env;
  const servedByName = new Map((opts.served ?? []).map((s) => [s.agentName, s]));
  const now = Date.now();

  const [rosters, callsToday, allHops] = await Promise.all([
    listRosters(opts.rosterBaseDir),
    a2aCallsToday({ baseDir: opts.budgetBaseDir }),
    readHops({ baseDir: opts.auditBaseDir, limit: 500 }),
  ]);

  // A served assistant may not have a roster file yet — include it too.
  const names = new Set<string>(rosters.map((r) => r.agentName));
  for (const s of servedByName.keys()) names.add(s);

  const cap = dailyCap(env);
  const hopLimit = opts.hopLimit ?? 25;

  const assistants: AssistantPanel[] = [];
  for (const agentName of [...names].sort()) {
    const roster = rosters.find((r) => r.agentName === agentName);
    const live = servedByName.get(agentName);
    const hops = allHops.filter((h) => h.from === agentName || h.to === agentName).slice(0, hopLimit);
    const outboundToday = countOutboundToday(allHops, agentName, now);

    assistants.push({
      agentName,
      owner: roster?.owner ?? '',
      live: Boolean(live),
      ...(live?.instanceId ? { instanceId: live.instanceId } : {}),
      ...(live?.startedAt ? { uptimeMs: now - live.startedAt } : {}),
      peers: (roster?.peers ?? []).map((p) => ({
        agentName: p.agentName,
        owner: p.owner,
        since: p.since,
        sharePolicy: p.sharePolicy,
        // Pillar 3 identity fields so the roster panel shows peers by NAME,
        // not just a handle (omitted when a back-compat roster lacks them).
        ...(p.displayName ? { displayName: p.displayName } : {}),
        ...(p.ownerName ? { ownerName: p.ownerName } : {}),
        ...(Array.isArray(p.aliases) && p.aliases.length ? { aliases: p.aliases } : {}),
        ...(Array.isArray(p.capabilities) && p.capabilities.length ? { capabilities: p.capabilities } : {}),
      })),
      peerCount: roster?.peers.length ?? 0,
      spendToday: { a2aCalls: outboundToday, dailyCap: cap },
      hops,
    });
  }

  return {
    ok: true,
    action: 'assistant-overview',
    generatedAt: now,
    dailyCap: cap,
    a2aCallsToday: callsToday,
    assistants,
  };
}

/** Count today's OUTBOUND hops a given assistant initiated (its A2A spend). */
function countOutboundToday(hops: A2AHop[], agentName: string, now: number): number {
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  return hops.filter((h) => h.direction === 'out' && h.from === agentName && h.at >= dayStart).length;
}
