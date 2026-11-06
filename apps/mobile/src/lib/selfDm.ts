// SPDX-License-Identifier: Apache-2.0
// Self DM routing: messaging yourself IS Saved. A peer hex that is the
// device's own key never opens a regular DM thread (which cannot send:
// the transport guard throws "cannot DM yourself"); it opens the Saved
// thread at /dm/self, backed by the device-only SelfMessageStore.
// Every entry point that can resolve to self (feed Message action, post
// detail, username search, hex paste, direct thread route, inbox row)
// decides through dmRouteForPeer so the rule lives in exactly one place.

/**
 * True when the candidate hex is the device's own key
 * (case-insensitive). False when the own key is unknown (null).
 */
export function isOwnHex(candidateHex: string | null | undefined, ownHex: string | null | undefined): boolean {
  if (!candidateHex || !ownHex) return false;
  return candidateHex.toLowerCase() === ownHex.toLowerCase();
}

/**
 * The route for opening a conversation with a peer: /dm/self for
 * yourself, /dm/<hex> for anyone else. A garbage peer hex still routes
 * to its thread; the thread screen itself rejects invalid keys.
 */
export function dmRouteForPeer(peerHex: string, ownHex: string | null | undefined): string {
  if (isOwnHex(peerHex, ownHex)) return '/dm/self';
  return `/dm/${peerHex.toLowerCase()}`;
}
