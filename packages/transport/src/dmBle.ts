// SPDX-License-Identifier: Apache-2.0
// DM over BLE: sealed-envelope frames on the shared BLE port, alongside
// (never inside) the feed path.
//
// Why a separate channel, not a feed event: a DM envelope is not a signed
// feed event, and it is bigger than one. A 4 KiB DM text seals to roughly
// 7 KiB of envelope JSON, past the feed 4 KiB event cap, so wrapping it in
// a feed event would be dropped by the feed reassembler. DM frames instead
// use the fragment flags channel (flags 1, see protocol fragment.ts) with
// their own reassembler (flags 1 only, 16 KiB cap) and a tag derived from
// the payload hash. The feed reassembler (flags 0 only) ignores DM frames
// before buffering, and pre-change installs reject flags 1 outright, so
// old installs drop DM frames silently instead of misreading them.
//
// Delivery model, stated plainly because the radio lies by omission: the
// GATT port notifies on our own TX characteristic, and a notify resolves
// successfully even when no peer central is subscribed yet. So publish()
// returning a peer count means "frames went out on the radio", never
// "the peer app received this". Only a peer ack (see dm.ts) upgrades a
// message to Delivered. Frames are broadcast to all subscribed centrals
// by the port, so every nearby phone receives every DM frame; only the
// envelope recipient can unseal it (MAC checked in dm.ts), and every
// other phone drops it in the service. There is no multi-hop DM relaying
// in v1: frames go to directly connected peers only, and intermediaries
// never re-broadcast them. That keeps the addressing honest (a DM that
// hopped through strangers would need a forwarding and ack-routing
// protocol this track does not invent).
//
// The transport never decrypts and never sees plaintext: it routes sealed
// envelopes by their JSON frame type ('dm' or 'ack') and delivery id.
// Dedup here is a session-level guard (same delivery id twice on this
// link); the service-level persistent dedup is authoritative.

import { sha256 } from '@noble/hashes/sha2.js';
import {
  DEFAULT_TTL,
  FRAG_FLAG_DM,
  FRAG_WIRE_MAX,
  Reassembler,
  REASSEMBLY_TIMEOUT_MS,
  fragmentTagged,
  type TransportPort,
} from '@airplane/protocol';
import type { DmEnvelope } from './dm';
import type { DmMeshPort } from './dmService';

/** Max reassembled DM frame bytes (envelope JSON for a 4 KiB text, plus headroom). */
export const DM_BLE_MAX_FRAME_BYTES = 16384;
/** Session dedup cap for delivery ids seen on this link. */
export const DM_BLE_SEEN_CAP = 5000;

interface DmBleFrame {
  v: 1;
  type: 'dm' | 'ack';
  envelope: DmEnvelope;
}

function isDmEnvelope(value: unknown): value is DmEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.ephemeralPubkeyHex === 'string' &&
    typeof e.recipientHex === 'string' &&
    typeof e.sealed === 'string' &&
    typeof e.createdAt === 'number'
  );
}

function parseDmBleFrame(bytes: Uint8Array): DmBleFrame | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DmBleFrame;
    if (parsed.v !== 1) return null;
    if (parsed.type !== 'dm' && parsed.type !== 'ack') return null;
    if (!isDmEnvelope(parsed.envelope)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class DmBleTransport implements DmMeshPort {
  private readonly reassembler = new Reassembler({ acceptFlags: [FRAG_FLAG_DM], maxBytes: DM_BLE_MAX_FRAME_BYTES });
  private readonly handlers = new Set<(e: DmEnvelope) => void>();
  private readonly ackHandlers = new Set<(e: DmEnvelope) => void>();
  private readonly seen = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private lastPurgeMs = 0;

  constructor(
    private readonly port: TransportPort,
    private readonly ttl: number = DEFAULT_TTL,
  ) {}

  /** Start listening for inbound DM frames. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.port.onReceive((_peerId, frame) => {
      const nowMs = Date.now();
      if (nowMs - this.lastPurgeMs > REASSEMBLY_TIMEOUT_MS) {
        this.reassembler.purge(nowMs);
        this.lastPurgeMs = nowMs;
      }
      let frameBytes: Uint8Array | null;
      try {
        frameBytes = this.reassembler.push(frame, nowMs);
      } catch {
        return; // malformed fragment, or a feed frame: never our channel
      }
      if (!frameBytes) return; // still waiting on more fragments
      const parsed = parseDmBleFrame(frameBytes);
      if (!parsed) return; // not a DM frame (or corrupt): drop, never crash
      const deliveryId = parsed.envelope.deliveryId;
      if (deliveryId !== undefined) {
        if (this.seen.has(deliveryId)) return; // session-level duplicate
        this.seen.add(deliveryId);
        while (this.seen.size > DM_BLE_SEEN_CAP) {
          const oldest = this.seen.values().next();
          if (oldest.done) break;
          this.seen.delete(oldest.value);
        }
      }
      const targets = parsed.type === 'dm' ? this.handlers : this.ackHandlers;
      for (const h of targets) {
        try {
          h(parsed.envelope);
        } catch {
          // handler errors must not break the transport
        }
      }
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Send one envelope to every connected peer. Returns how many peers
   * took all frames without error. Zero means no peer could take it
   * (no connections, or the radio threw): the caller queues, it does
   * not claim delivery. A positive count is still only a radio handoff.
   */
  async publish(envelope: DmEnvelope, kind: 'dm' | 'ack'): Promise<number> {
    const frame: DmBleFrame = { v: 1, type: kind, envelope };
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    const tagBytes = sha256(bytes);
    const msgTag = ((tagBytes[0] << 24) | (tagBytes[1] << 16) | (tagBytes[2] << 8) | tagBytes[3]) >>> 0;
    let peerIds: string[] = [];
    try {
      peerIds = this.port.connectedPeerIds?.() ?? [];
    } catch {
      peerIds = [];
    }
    let sent = 0;
    for (const peerId of peerIds) {
      try {
        const frameSize = this.port.frameSizeFor?.(peerId) ?? FRAG_WIRE_MAX;
        const frames = fragmentTagged(bytes, msgTag, this.ttl, frameSize, FRAG_FLAG_DM);
        for (const frameBytes of frames) {
          await this.port.send(peerId, frameBytes);
        }
        sent += 1;
      } catch {
        // per-peer send failures are non-fatal (peer may have dropped)
      }
    }
    return sent;
  }

  subscribe(onEnvelope: (e: DmEnvelope) => void, onAck: (e: DmEnvelope) => void): () => void {
    this.start();
    this.handlers.add(onEnvelope);
    this.ackHandlers.add(onAck);
    return () => {
      this.handlers.delete(onEnvelope);
      this.ackHandlers.delete(onAck);
    };
  }
}
