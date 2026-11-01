// SPDX-License-Identifier: Apache-2.0
// Wi-Fi LAN transport (T15 Phase 1): same-LAN sync over TCP.
//
// Two phones on the same Wi-Fi network, or one on the other's hotspot,
// discover each other via NSD/mDNS and exchange signed events over TCP.
// This is the third opportunistic transport alongside BLE mesh and Nostr
// relays, and it slots into the ordered router between relay and mesh:
// relay first when online, LAN next, mesh fallback last (see hybrid.ts).
//
// Wire format: exactly the protocol fragment format BLE uses (11-byte
// header plus payload, see flood/fragment.ts), carried inside a
// length-prefixed TCP frame (4-byte big-endian length, then one
// fragment). TCP is reliable and ordered, so a frame normally arrives
// whole; the fragment/reassembly layer is still used so an event larger
// than one frame, or a future chunked sender, reassembles the same way
// as on BLE, and so the same MAX_EVENT_BYTES cap bounds a peer.
//
// Identity: a LAN peer is identified by its full pubkey hex, the same
// identity posts already carry. NSD advertises that pubkey in a TXT
// record, so a discovered peer needs no extra identity exchange: the
// discovering side can address it by pubkey immediately, and the
// receiving side learns the sender from the signed event itself.
// Nothing here is encrypted beyond the signature: like BLE mesh, a LAN
// post is a public signed event, and anyone on the same network who
// receives it can read it. DMs never flow over this transport in v1;
// DmService stays relay-only.
//
// Platform split: this file is platform-free. The native NSD/TCP half
// lives behind LanPort (Android: AirplaneLanModule.kt; the app adapter
// is services/airplane/lan.ts). A missing native module must fail
// closed to inert: the adapter swallows native errors, so LanTransport
// never throws at start and simply discovers no peers.

import {
  SeenCache,
  decodeEvent,
  encodeEvent,
  toHex,
  DEFAULT_TTL,
  REASSEMBLY_TIMEOUT_MS,
  fragment,
  Reassembler,
  type Hex64,
  type SignedEvent,
} from '@airplane/protocol';

/**
 * One TCP frame is far larger than a BLE ATT write, and events are
 * capped at MAX_EVENT_BYTES (4096) by the protocol, so a single frame
 * normally carries a whole event. 8192 leaves headroom for the fragment
 * header while staying one TCP write per event in practice.
 */
export const LAN_FRAME_MAX = 8192;

/** Native NSD/TCP half of the LAN transport, supplied by the app. */
export interface LanPort {
  /** Register the NSD service and start discovery plus the TCP server. */
  start(): Promise<void>;
  /** Unregister, stop discovery, close the TCP server. */
  stop(): Promise<void>;
  /** Pubkey hex of every peer currently discovered on this LAN. */
  discoveredPeerIds(): string[];
  /** Send one raw frame to a discovered peer (must fit the frame size). */
  send(peerId: string, bytes: Uint8Array): Promise<void>;
  /**
   * Max bytes this port accepts in a single send() call for the peer.
   * Optional; when absent the LAN frame size is used.
   */
  frameSizeFor?(peerId: string): number;
  /** Subscribe to inbound frames. Returns an unsubscribe function. */
  onReceive(cb: (bytes: Uint8Array) => void): () => void;
}

export interface LanTransportOpts {
  ttl?: number;
  /**
   * Event authenticity check, matching the BLE path (T11): an event
   * failing the check, or a check that throws, is dropped silently,
   * never delivered. The app always wires verifyEvent.
   */
  verify?: (event: SignedEvent) => boolean;
  /** Diagnostics hook only: called when a decoded, verified event is dropped as a duplicate. */
  onDedupDrop?: (peerId: string) => void;
}

/**
 * LAN-side transport. Wraps a LanPort with the same CBOR
 * encode/decode, signature verification, and seen-cache loop
 * suppression as BleTransport, so a post arriving via LAN and relay
 * is emitted exactly once by the hybrid ingress above.
 */
export class LanTransport {
  private readonly seen = new SeenCache();
  private readonly handlers = new Set<(event: SignedEvent, peerId: string) => void>();
  private readonly reassembler = new Reassembler();
  private readonly ttl: number;
  private readonly verify: ((event: SignedEvent) => boolean) | undefined;
  private readonly onDedupDrop: ((peerId: string) => void) | undefined;
  private unsubscribe: (() => void) | null = null;
  private lastPurgeMs = 0;

  constructor(
    private readonly port: LanPort,
    opts?: LanTransportOpts,
  ) {
    this.ttl = opts?.ttl ?? DEFAULT_TTL;
    this.verify = opts?.verify;
    this.onDedupDrop = opts?.onDedupDrop;
  }

  /** Start listening for inbound frames. Idempotent. Never throws: a native failure leaves the transport inert. */
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    try {
      await this.port.start();
    } catch {
      // Fail closed: no peers, no sends, app keeps running on the other transports.
    }
    this.unsubscribe = this.port.onReceive((frame) => {
      const nowMs = Date.now();
      if (nowMs - this.lastPurgeMs > REASSEMBLY_TIMEOUT_MS) {
        this.reassembler.purge(nowMs);
        this.lastPurgeMs = nowMs;
      }
      let eventBytes: Uint8Array | null;
      try {
        eventBytes = this.reassembler.push(frame, nowMs);
      } catch {
        return; // malformed fragment - drop
      }
      if (!eventBytes) return; // still waiting on more fragments
      let event: SignedEvent;
      try {
        event = decodeEvent(eventBytes);
      } catch {
        return; // malformed event - drop
      }
      if (this.verify) {
        let ok = false;
        try {
          ok = this.verify(event);
        } catch {
          ok = false;
        }
        if (!ok) return; // bad id/signature - drop, never deliver
      }
      const idHex = toHex(event.id);
      if (this.seen.has(idHex)) {
        this.onDedupDrop?.(toHex(event.pubkey));
        return;
      }
      this.seen.add(idHex);
      // The sender is the event author: TCP carries no peer identity
      // of its own, and the signed event is the identity that matters.
      const peerId = toHex(event.pubkey);
      for (const h of this.handlers) {
        try {
          h(event, peerId);
        } catch {
          // handler errors must not break the transport
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    try {
      await this.port.stop();
    } catch {
      // Stopping must never throw into the app lifecycle.
    }
  }

  /**
   * Broadcast one event to all given LAN peers. The event is
   * fragmented to each peer's port frame size (normally one frame);
   * every frame goes through port.send(). Marks the id seen so our
   * own broadcast is not re-emitted on receipt. Returns the count
   * of peers that completed without error.
   */
  async broadcast(event: SignedEvent, peerIds: string[]): Promise<number> {
    const bytes = encodeEvent(event);
    this.seen.add(toHex(event.id));
    let sent = 0;
    for (const peerId of peerIds) {
      try {
        const frameSize = this.port.frameSizeFor?.(peerId) ?? LAN_FRAME_MAX;
        const frames = fragment(bytes, this.ttl, frameSize);
        for (const frame of frames) {
          await this.port.send(peerId, frame);
        }
        sent += 1;
      } catch {
        // per-peer send failures are non-fatal (peer may have left the LAN)
      }
    }
    return sent;
  }

  /** Has this event id been seen on LAN (sent or received)? */
  hasSeen(idHex: Hex64): boolean {
    return this.seen.has(idHex);
  }

  /** Pubkey hex of every peer currently discovered on this LAN. */
  discoveredPeerIds(): string[] {
    try {
      return this.port.discoveredPeerIds();
    } catch {
      return [];
    }
  }

  /** Subscribe to decoded inbound events. */
  onReceive(cb: (event: SignedEvent, peerId: string) => void): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }
}
