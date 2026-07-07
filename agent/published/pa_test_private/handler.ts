/**
 * pa_test_private — a PRIVATE personal agent that delegates to OTHER
 * Blocks agents (docs/PERSONAL-ASSISTANT-PLAN.md, end-state A).
 *
 * This is the "agent that uses other agents" pattern: the handler runs the
 * shared personal-assistant runtime (agent/src/assistant/assistant-runtime.ts), which
 * gates on the owner, asks the PA-1 brain for a plan, then delegates to a
 * network specialist by skill tag (reusing the chat's connect/discover/call
 * seam). So a "make me an image" request comes back as a real PNG.
 *
 * Owner binding rides in via env (PA_OWNER_ID / PA_OWNER_ORG_ID) so this
 * throwaway probe needs no per-owner code. The productized pa_<owner>
 * agents (Phase PA-2) bake the owner into the handler instead — see
 * agent/src/assistant/assistant-factory.ts.
 *
 * The instance must be served with BLOCKS_API_KEY in env (blocks run) for
 * the delegated call to reach the live network.
 */

import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';
import { runAssistant } from '../../src/assistant/assistant-runtime.ts';
import { ownerPolicyFromEnv } from '../../src/server/authorize.ts';

loadRootEnv();

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  return runAssistant(task, ctx, ownerPolicyFromEnv());
}
