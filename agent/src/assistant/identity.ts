import { connect } from '../blocks/blocks-client.ts';

export interface BlocksIdentity {
  ownerId: string;
  orgId?: string;
}

export type IdentitySource = () => Promise<BlocksIdentity>;

export function identityResponse(identity: BlocksIdentity) {
  return {
    ok: true,
    action: 'identity',
    ownerId: identity.ownerId,
    ...(identity.orgId ? { orgId: identity.orgId } : {}),
  };
}

export async function getBlocksConsumerIdentity(): Promise<BlocksIdentity> {
  if (!process.env.BLOCKS_API_KEY) {
    throw new Error('BLOCKS_API_KEY is missing — add it to .env to read the Blocks identity');
  }

  const session = await connect({ offline: false, latencyScale: 0 });
  try {
    const ownerId = session.getUserId();
    if (!ownerId) throw new Error('Blocks SDK did not return an ownerId for the API key');
    return { ownerId, orgId: ownerId };
  } finally {
    session.close();
  }
}

export async function apiIdentity(source: IdentitySource = getBlocksConsumerIdentity) {
  return identityResponse(await source());
}
