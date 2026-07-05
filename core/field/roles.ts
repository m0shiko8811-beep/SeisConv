// seisconv-core/field — role encoding + auto-negotiation (ported from discovery.py / gui.py)

import type { Role } from './types';
import { ROLE_TO_BYTE, BYTE_TO_ROLE } from './constants';

/** Role → beacon byte (both=0, master=1, slave=2). Unknown → 0 ("both"). */
export function roleToByte(role: Role): number {
  return ROLE_TO_BYTE[role] ?? 0;
}

/** Beacon byte → role. Unknown byte → "both". */
export function byteToRole(b: number): Role {
  return BYTE_TO_ROLE[b] ?? 'both';
}

/**
 * Auto-negotiation complement: when a peer advertises a definite role we adopt
 * the opposite so the pair pins to master↔slave. A "both" peer triggers no
 * negotiation (returns null).
 *   peer master → we slave; peer slave → we master; peer both → null.
 */
export function complementRole(peerRole: Role): Role | null {
  if (peerRole === 'master') return 'slave';
  if (peerRole === 'slave') return 'master';
  return null;
}
