import { canonicalJson } from '@kiu/shared';
import { sha256Hex } from './crypto';

/** Hash of the (non-existent) entry before the first audit record. */
export const GENESIS_HASH = '0'.repeat(64);

export { canonicalJson };

export interface ChainedEntry {
  payload: unknown;
  prevHash: string;
  hash: string;
}

export function chainHash(prevHash: string, payload: unknown): string {
  return sha256Hex(`${prevHash}|${canonicalJson(payload)}`);
}

/** Returns the index of the first broken link, or -1 when the chain is intact. */
export function verifyChain(entries: ChainedEntry[]): number {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.prevHash !== prev || e.hash !== chainHash(prev, e.payload)) return i;
    prev = e.hash;
  }
  return -1;
}
