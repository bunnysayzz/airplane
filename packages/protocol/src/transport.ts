// SPDX-License-Identifier: Apache-2.0
// TransportPort: the BLE transport contract.
// FROZEN — breaking changes need an ADR. Implementations live in the
// platform packages (BLE GATT client/peripheral); this package only defines
// the interface so flood logic stays transport-agnostic and testable.

import type { PeerInfo, UnixSec } from './events/types';

/** Lifecycle + data events a transport may surface. */
export type TransportEvent =
  | { type: 'peer-found'; peer: PeerInfo }
  | { type: 'peer-lost'; peerId: string }
  | { type: 'connected'; peerId: string }
  | { type: 'disconnected'; peerId: string; reason?: string }
  | { type: 'receive'; peerId: string; bytes: Uint8Array; atSec: UnixSec };

/**
 * Minimal BLE transport surface the mesh needs:
 * advertise this node's presence, scan for peers, connect, and exchange
 * raw frames. All payload framing (fragment headers) is handled above this
 * layer in flood/fragment.ts.
 */
export interface TransportPort {
  /** Start advertising our peerId so nearby nodes can discover us. */
  advertise(peerId: string): Promise<void>;
  /** Stop advertising. */
  stopAdvertise(): Promise<void>;
  /**
   * Start scanning; `onPeer` fires for each discovered peer (and repeats as
   * advertisements are re-heard). Resolves to an unsubscribe/stop function.
   */
  scan(onPeer: (peer: PeerInfo) => void): Promise<() => void>;
  /** Connect to a discovered peer (GATT client role). */
  connect(peerId: string): Promise<void>;
  /** Disconnect from a peer. */
  disconnect(peerId: string): Promise<void>;
  /** Send one raw frame to a connected peer (must fit the link MTU). */
  send(peerId: string, bytes: Uint8Array): Promise<void>;
  /** Subscribe to inbound frames. Returns an unsubscribe function. */
  onReceive(cb: (peerId: string, bytes: Uint8Array) => void): () => void;
}
