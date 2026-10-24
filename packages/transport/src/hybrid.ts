// SPDX-License-Identifier: Apache-2.0
// Hybrid transport: BLE mesh + Nostr relay orchestration.
//
// BleTransport wraps the frozen TransportPort (BLE GATT) with the flood
// engine's SeenCache for loop suppression - the engine itself is untouched.
// HybridTransport runs both transports concurrently and deduplicates every
// inbound event by event ID (hex), so a post arriving via BLE and Nostr is
// emitted exactly once.

import {
  SeenCache,
  decodeEvent,
  encodeEvent,
  toHex,
  DEFAULT_TTL,
  FRAG_WIRE_MAX,
  REASSEMBLY_TIMEOUT_MS,
  fragment,
  Reassembler,
  type Hex64,
  type SignedEvent,
  type TransportPort,
} from '@airplane/protocol';
import { NostrTransport, type NostrTransportOpts } from './nostr';

/** Where an inbound post arrived from. */
export type IngressSource = 'ble' | 'nostr' | 'local';

/**
 * BLE-side transport. Wraps a TransportPort (real GATT on device,
 * SimTransport in tests) and handles CBOR encode/decode around it.
 *
 * Wire reality: a port frame carries ONE protocol fragment (11-byte header +
 * payload, see flood/fragment.ts), never a whole event. broadcast()
 * fragments each event to the port's per-peer frame size (MTU-aware
 * chunking); the receive path reassembles fragments back into complete
 * event bytes before decoding. Flood relay decisions (TTL, jitter,
 * seen-cache) stay in the caller's flood loop; this class only moves
 * complete events.
 */
export class BleTransport {
  private readonly seen = new SeenCache();
  private readonly handlers = new Set<(event: SignedEvent, peerId: string) => void>();
  private readonly reassembler = new Reassembler();
  private readonly ttl: number;
  private unsubscribe: (() => void) | null = null;
  private lastPurgeMs = 0;

  constructor(
    private readonly port: TransportPort,
    opts?: { ttl?: number },
  ) {
    this.ttl = opts?.ttl ?? DEFAULT_TTL;
  }

  /** Start listening for inbound frames. Idempotent. */
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.port.onReceive((peerId, frame) => {
      // Opportunistic reassembly-buffer purge: no timers in this class.
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
      const idHex = toHex(event.id);
      if (this.seen.has(idHex)) return; // loop suppression
      this.seen.add(idHex);
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
  }

  /**
   * Broadcast one event to all connected BLE peers.
   * The event is fragmented to each peer's port frame size (MTU-aware);
   * every frame goes through port.send() which must fit the link MTU.
   * Marks the id seen so our own broadcast isn't re-emitted on receipt.
   */
  async broadcast(event: SignedEvent, peerIds: string[]): Promise<void> {
    const bytes = encodeEvent(event);
    this.seen.add(toHex(event.id));
    for (const peerId of peerIds) {
      try {
        const frameSize = this.port.frameSizeFor?.(peerId) ?? FRAG_WIRE_MAX;
        const frames = fragment(bytes, this.ttl, frameSize);
        for (const frame of frames) {
          await this.port.send(peerId, frame);
        }
      } catch {
        // per-peer send failures are non-fatal (peer may have dropped,
        // or the port reported an unusable frame size)
      }
    }
  }

  /** Has this event id been seen on BLE (sent or received)? */
  hasSeen(idHex: Hex64): boolean {
    return this.seen.has(idHex);
  }

  /** Subscribe to decoded inbound events. */
  onReceive(cb: (event: SignedEvent, peerId: string) => void): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }
}

export interface HybridTransportOpts {
  nostr?: NostrTransportOpts;
}

/**
 * Runs BLE mesh and Nostr relays concurrently. Single ingress for inbound
 * posts from any source; cross-transport dedup by event ID hex ensures a
 * post is emitted exactly once even when it arrives via both.
 *
 * Outbound: `publish` fans out to BLE peers and all open relays.
 */
export class HybridTransport {
  private readonly seen = new SeenCache();
  private readonly handlers = new Set<(event: SignedEvent, source: IngressSource) => void>();
  private readonly bleUnsubs: (() => void)[] = [];
  readonly nostr: NostrTransport;

  constructor(
    private readonly ble: BleTransport,
    nostrOpts?: NostrTransportOpts,
  ) {
    this.nostr = new NostrTransport(nostrOpts);
  }

  async start(): Promise<void> {
    await this.ble.start();
    await this.nostr.start();
    this.bleUnsubs.push(
      this.ble.onReceive((event) => this.ingress(event, 'ble')),
      this.nostr.onReceive((event) => this.ingress(event, 'nostr')),
    );
  }

  async stop(): Promise<void> {
    for (const u of this.bleUnsubs.splice(0)) u();
    await this.ble.stop();
    await this.nostr.stop();
  }

  /**
   * Single ingress point. Deduplicates across transports by event ID;
   * first arrival wins, later duplicates are dropped silently.
   */
  ingress(event: SignedEvent, source: IngressSource): boolean {
    const idHex = toHex(event.id);
    if (this.seen.has(idHex)) return false;
    this.seen.add(idHex);
    for (const h of this.handlers) {
      try {
        h(event, source);
      } catch {
        // handler errors must not break the transport
      }
    }
    return true;
  }

  /**
   * Publish a locally-created event: mark seen (so the echo isn't
   * re-emitted), fan out to BLE peers and Nostr relays.
   */
  async publish(event: SignedEvent, blePeerIds: string[] = []): Promise<{ blePeers: number; relays: string[] }> {
    const idHex = toHex(event.id);
    this.seen.add(idHex);
    let blePeers = 0;
    if (blePeerIds.length > 0) {
      await this.ble.broadcast(event, blePeerIds);
      blePeers = blePeerIds.length;
    }
    const relays = await this.nostr.publish(event);
    // Also emit locally so the feed store sees our own post through the
    // same path as remote ones.
    for (const h of this.handlers) {
      try {
        h(event, 'local');
      } catch {
        // ignore
      }
    }
    return { blePeers, relays };
  }

  /** Subscribe to deduplicated inbound posts from any source. */
  onPost(cb: (event: SignedEvent, source: IngressSource) => void): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  /** True when at least one Nostr relay is connected. */
  get nostrOnline(): boolean {
    return this.nostr.online;
  }
}
