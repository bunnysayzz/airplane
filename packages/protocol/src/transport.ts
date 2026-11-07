// SPDX-License-Identifier: Apache-2.0
// TransportPort: the BLE transport contract.
// FROZEN - breaking changes need an ADR. Implementations live in the
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
  /**
   * Max bytes this port accepts in a single send() call for the peer.
   * The mesh layer fragments events so every frame fits this size.
   * Optional and additive (not a breaking change): when absent the mesh
   * layer falls back to the protocol default frame size (FRAG_WIRE_MAX).
   */
  frameSizeFor?(peerId: string): number;
  /**
   * Full peerIds of currently established connections (identity known).
   * Optional and additive (not a breaking change): ports that do not track
   * connections omit it, and callers fall back to an empty peer set.
   * Provisional ids (tag:/mac: keys) are never returned - only peers whose
   * full identity has been resolved can receive frames.
   */
  connectedPeerIds?(): string[];
  /**
   * Full peerIds sighted recently (identity resolved earlier), whether
   * or not a live connection exists. Optional and additive (not a
   * breaking change): ports that do not track sightings omit it, and
   * callers fall back to connected peers only. A sighted peer is one
   * whose advertisement was heard inside the port's fresh window; it
   * may or may not be subscribed to our TX.
   */
  sightedPeerIds?(): string[];
  /**
   * Notify one raw frame to a peer with no live connection (blind
   * notify on our own TX, chunked at the last-known MTU for that
   * peer). Resolves when the native layer accepts the notify, which
   * is a radio handoff, not a receipt: the peer central must be
   * subscribed to our TX for the frame to land. Optional and
   * additive: ports without it skip sighted-only targets.
   */
  notifyUnconnected?(peerId: string, bytes: Uint8Array): Promise<void>;
  /**
   * Send a per-post BLE acknowledgement datagram to a connected peer
   * (the 32-byte event id the peer's post carried). Best effort:
   * throws when no connection exists. Optional and additive.
   */
  sendAck?(peerId: string, eventId: Uint8Array): Promise<void>;
  /** Subscribe to inbound BLE acknowledgement datagrams. Returns an unsubscribe function. Optional and additive. */
  onAck?(cb: (peerId: string, eventId: Uint8Array) => void): () => void;
  /**
   * BLE liveness watchdog (v0.1.36): attempt (re)connects for sighted
   * peers with no live connection, bounded by the port's cooldown,
   * and escalate to a bounded radio reset after repeated connect
   * timeouts. Optional and additive: ports without it never run it.
   */
  runBleLivenessWatchdog?(): void;
  /** Subscribe to inbound frames. Returns an unsubscribe function. */
  onReceive(cb: (peerId: string, bytes: Uint8Array) => void): () => void;
}
