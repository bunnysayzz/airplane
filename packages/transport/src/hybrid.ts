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
  private readonly verify: ((event: SignedEvent) => boolean) | undefined;
  private readonly onDedupDrop: ((peerId: string) => void) | undefined;
  private unsubscribe: (() => void) | null = null;
  private lastPurgeMs = 0;

  constructor(
    private readonly port: TransportPort,
    opts?: {
      ttl?: number;
      /**
       * Event authenticity check (T11 §23.6: the BLE ingress path must
       * reject tampered/wrong-key signatures, matching the Nostr path
       * which already verifies). When supplied, an event failing the
       * check — or a check that throws — is dropped silently, never
       * delivered to handlers. Absent, decoding alone gates delivery
       * (legacy behavior, kept for tests that construct unsigned
       * fixtures); the app always wires verifyEvent.
       */
      verify?: (event: SignedEvent) => boolean;
      /**
       * Diagnostics hook only (R2): called when a decoded, verified
       * event is dropped as a loop-suppression duplicate. No routing
       * decision reads it; it only feeds the diagnostics counters.
       */
      onDedupDrop?: (peerId: string) => void;
    },
  ) {
    this.ttl = opts?.ttl ?? DEFAULT_TTL;
    this.verify = opts?.verify;
    this.onDedupDrop = opts?.onDedupDrop;
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
        this.onDedupDrop?.(peerId); // loop suppression
        return;
      }
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
   * Returns the count of peers that completed without error, so the
   * router can tell "sent to N peers" from "failed on every peer".
   */
  async broadcast(event: SignedEvent, peerIds: string[]): Promise<number> {
    const bytes = encodeEvent(event);
    this.seen.add(toHex(event.id));
    let sent = 0;
    for (const peerId of peerIds) {
      try {
        const frameSize = this.port.frameSizeFor?.(peerId) ?? FRAG_WIRE_MAX;
        const frames = fragment(bytes, this.ttl, frameSize);
        for (const frame of frames) {
          await this.port.send(peerId, frame);
        }
        sent += 1;
      } catch {
        // per-peer send failures are non-fatal (peer may have dropped,
        // or the port reported an unusable frame size)
      }
    }
    return sent;
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

/** Diagnostics-only options for HybridTransport (R2). No routing reads them. */
export interface HybridDiagnosticsOpts {
  /** Called when ingress drops an event as a cross-transport duplicate. */
  onDedupDrop?: (source: IngressSource, peerId: string | null) => void;
}

/**
 * Delivery status for one routed publish. Monotonic within a publish:
 * a failed relay attempt never moves the result backward, it only falls
 * through to the next stage. R4 reaches queued, sent, and relayed only.
 * delivered (peer ack) and read arrive with peer acks in a later track.
 */
export type RouterStatus = 'queued' | 'sent' | 'relayed';

/** Which stage won a routed publish, or none when nothing could send. */
export type RouterTransport = 'relay' | 'mesh' | 'none';

/**
 * Result of one routed publish. blePeers and relays keep their old
 * meaning for callers: blePeers is the count of BLE peers sent to,
 * relays is the list of relay URLs that sent an accepted OK.
 */
export interface RouteResult {
  transport: RouterTransport;
  status: RouterStatus;
  blePeers: number;
  relays: string[];
  /** True when the relay stage was actually attempted. */
  relayTried: boolean;
  /** Why the relay stage was skipped or failed; null when relay won. */
  relayDetail: string | null;
}

/** Ordered-router options (R4). */
export interface RouterOpts {
  /**
   * How long to wait for the first accepted relay OK before falling
   * through to mesh, in ms. Default 5000 (a few seconds, per plan).
   */
  relayDeadlineMs?: number;
  /**
   * Validated-network fact, supplied by the app (NetInfo). When present,
   * the relay stage runs only when it returns true: a positive offline
   * signal skips the relay wait and falls through at once. When absent,
   * the live relay-socket fact alone gates the relay stage, which keeps
   * package-level callers and builds without a connectivity module
   * working exactly as before.
   */
  networkValidated?: () => boolean;
}

/** Default relay OK deadline (ms). */
export const DEFAULT_RELAY_DEADLINE_MS = 5000;

/**
 * Runs BLE mesh and Nostr relays in strict order (R4): relay first when
 * the network is validated and a relay socket is live, mesh fallback on
 * relay timeout, rejection, or no socket, queued when no transport can
 * send. Single ingress for inbound posts from any source; cross-transport
 * dedup by event ID hex ensures a post is emitted exactly once even when
 * it arrives via both.
 *
 * DMs do not flow through this router. DmService stays relay-only, and
 * R4 adds no BLE DM path, so D1 (strict relay first, no warm-peer BLE
 * shortcut for DMs) holds by construction.
 *
 * Outbound: `publish` routes through the stages in order. It reports the
 * winning stage and status but does NOT persist a queued result: the
 * durable outbox with retry and drain is a later track (R5). A queued
 * result means "reported, not stored"; callers must not treat it as
 * a delivery promise.
 */
export class HybridTransport {
  private readonly seen = new SeenCache();
  private readonly handlers = new Set<(event: SignedEvent, source: IngressSource) => void>();
  private readonly bleUnsubs: (() => void)[] = [];
  readonly nostr: NostrTransport;
  private readonly diagnosticsOpts: HybridDiagnosticsOpts | undefined;
  private readonly relayDeadlineMs: number;
  private readonly networkValidated: (() => boolean) | undefined;

  constructor(
    private readonly ble: BleTransport,
    nostrOpts?: NostrTransportOpts,
    diagnosticsOpts?: HybridDiagnosticsOpts,
    routerOpts?: RouterOpts,
  ) {
    this.nostr = new NostrTransport(nostrOpts);
    this.diagnosticsOpts = diagnosticsOpts;
    this.relayDeadlineMs = routerOpts?.relayDeadlineMs ?? DEFAULT_RELAY_DEADLINE_MS;
    this.networkValidated = routerOpts?.networkValidated;
  }

  async start(): Promise<void> {
    await this.ble.start();
    await this.nostr.start();
    this.bleUnsubs.push(
      this.ble.onReceive((event, peerId) => this.ingress(event, 'ble', peerId)),
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
  ingress(event: SignedEvent, source: IngressSource, peerId?: string): boolean {
    const idHex = toHex(event.id);
    if (this.seen.has(idHex)) {
      this.diagnosticsOpts?.onDedupDrop?.(source, peerId ?? null);
      return false;
    }
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
   * Publish a locally-created event through the ordered router.
   * Stage order is fixed: relay first, mesh fallback, queued when
   * neither can send. A future LAN stage slots in between relay and
   * mesh: it must run after the relay stage, never before it, so the
   * relay-first order and D1 hold for every transport added later.
   * Marks the id seen (so the echo is not re-emitted), then emits
   * locally so the feed store sees our own post through the same path
   * as remote ones.
   */
  async publish(event: SignedEvent, blePeerIds: string[] = []): Promise<RouteResult> {
    const idHex = toHex(event.id);
    this.seen.add(idHex);
    const relay = await this.attemptRelay(event);
    let result: RouteResult;
    if (relay.ok.length > 0) {
      result = {
        transport: 'relay',
        status: 'relayed',
        blePeers: 0,
        relays: relay.ok,
        relayTried: true,
        relayDetail: null,
      };
    } else {
      result = await this.attemptMesh(event, blePeerIds, relay);
    }
    for (const h of this.handlers) {
      try {
        h(event, 'local');
      } catch {
        // ignore
      }
    }
    return result;
  }

  /**
   * Relay stage. Returns the accepted-OK URLs, or an empty list with
   * the reason the stage did not win. Skips the wait entirely when the
   * network is known offline or no relay socket is open: per plan, a
   * relay client in backoff is not waited on, it is fallen through.
   */
  private async attemptRelay(event: SignedEvent): Promise<{
    ok: string[];
    tried: boolean;
    detail: string | null;
  }> {
    if (this.networkValidated && !this.networkValidated()) {
      return { ok: [], tried: false, detail: 'network not validated' };
    }
    if (!this.nostr.online) {
      return { ok: [], tried: false, detail: 'no open relay socket' };
    }
    const ack = await this.nostr.publishWithAck(event, this.relayDeadlineMs);
    if (ack.ok.length > 0) return { ok: ack.ok, tried: true, detail: null };
    if (ack.rejected.length > 0) return { ok: [], tried: true, detail: 'relays rejected the event' };
    if (ack.timedOut) return { ok: [], tried: true, detail: `no relay OK within ${this.relayDeadlineMs}ms` };
    return { ok: [], tried: true, detail: 'relay unavailable' };
  }

  /**
   * Mesh stage. Broadcasts to the given peers, or reports queued when
   * there is no peer to send to. Queued is a report, not storage: the
   * durable outbox (R5) owns persistence, retry, and drain.
   */
  private async attemptMesh(
    event: SignedEvent,
    blePeerIds: string[],
    relay: { ok: string[]; tried: boolean; detail: string | null },
  ): Promise<RouteResult> {
    if (blePeerIds.length === 0) {
      return {
        transport: 'none',
        status: 'queued',
        blePeers: 0,
        relays: [],
        relayTried: relay.tried,
        relayDetail: relay.detail,
      };
    }
    const sent = await this.ble.broadcast(event, blePeerIds);
    if (sent === 0) {
      return {
        transport: 'none',
        status: 'queued',
        blePeers: 0,
        relays: [],
        relayTried: relay.tried,
        relayDetail: relay.detail,
      };
    }
    return {
      transport: 'mesh',
      status: 'sent',
      blePeers: sent,
      relays: [],
      relayTried: relay.tried,
      relayDetail: relay.detail,
    };
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
