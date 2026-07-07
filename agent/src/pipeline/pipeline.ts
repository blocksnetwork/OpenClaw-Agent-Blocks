/**
 * Pipeline — sequential coordination ("summarize → translate → speak").
 *
 * ONE Blocks session for the whole chain. Each step discovers an agent
 * by skill, calls it with the same retrying caller fan-out uses, and
 * feeds its `data` into the next step's input mapper. Returns every
 * intermediate CallResult plus the combined audit (one row per step).
 */

import { connect, type ConnectOptions } from '../blocks/blocks-client.ts';
import { callWithRetry, retryPolicy } from './fanout.ts';
import type { CallMeta, CallResult } from '../types.ts';

export interface PipelineStep {
  /** Skill tag used to discover this step's agent. */
  skill: string;
  /** Build this step's inputs from the previous step's `data`
   *  (`undefined` for the first step). */
  mapInputs: (prev: unknown) => Record<string, unknown>;
}

export interface PipelineOptions {
  tries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  latencyScale?: number;
  onPartial?: ConnectOptions['onPartial'];
}

export interface PipelineResult {
  /** One CallResult per step, in execution order. */
  steps: CallResult[];
  audit: CallMeta[];
}

export async function pipeline(
  steps: PipelineStep[],
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  if (steps.length === 0) throw new Error('pipeline needs at least one step');
  const policy = retryPolicy(opts);

  const session = await connect({
    latencyScale: opts.latencyScale,
    onPartial: opts.onPartial,
  });

  try {
    const results: CallResult[] = [];
    let prev: unknown;

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const agents = await session.discover(step.skill);
      if (agents.length === 0) {
        throw new Error(`pipeline step ${i + 1}: no agent found for skill "${step.skill}"`);
      }

      const target = { handle: agents[0].handle, skill: step.skill };
      const outcome = await callWithRetry(session, target, step.mapInputs(prev), policy);
      if (!outcome.ok) {
        throw new Error(
          `pipeline step ${i + 1} (${step.skill} via ${target.handle}) failed after `
            + `${outcome.attempts} attempt(s): ${outcome.reason}`,
        );
      }

      results.push(outcome.result);
      prev = outcome.result.data;
    }

    return { steps: results, audit: results.map((r) => r.meta) };
  } finally {
    session.close();
  }
}
