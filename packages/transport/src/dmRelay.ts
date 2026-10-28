// SPDX-License-Identifier: Apache-2.0
// DM relay port over plain WebSocket (no Google services).
//
// The on-wire event is a valid NIP-01 event (kind 1059, gift-wrap-shaped):
// id = sha256([0, pubkey, created_at, kind, tags, content]), schnorr-signed
// with a fresh ephemeral secp256k1 key per send. `content` is the JSON
// DmEnvelope (ephemeral X25519 pubkey + recipient hex + sealed rumor); the
// `p` tag carries the recipient mesh hex so relays can filter with
// {"kinds":[1059],"#p":[ownHex]}. Relays see recipient + ephemeral pubkey,
// never plaintext. Signature validity is what relays check; the app-level
// trust boundary is the sealed rumor (see dm.ts header).
//
// R5 FAST PATH (plan section 7): this replaces the P1 behaviour (fresh
// socket per relay per send, relays in order, up to 10 s each) with:
// * one pooled socket per relay, held across sends and reused;
// * parallel publish to all relays with a short first-OK deadline
//   (default 5 s): the first relay OK wins, the others are ignored, and
//   a slow relay never makes a DM feel slow;
// * a live subscription held across drops: on close the socket reconnects
//   with bounded exponential backoff and re-sends its REQ, with a `since`
//   backfill from the last envelope seen, so gaps are fetched, not lost;
// * EOSE is never a gate: EVENT frames are delivered the moment they
//   arrive, before or after any EOSE frame;
// * per-relay health (OKs, failures, last OK latency) so a slow or dead
//   relay is visible and loses the first-OK race instead of blocking it.
// D1 default holds: strict relay first, no direct-BLE shortcut for DMs.
// There is still no BLE DM path in this file; a mesh fallback for DMs is
// a separate follow-up, not claimed here.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { dmToHex, type DmEnvelope } from './dm';
import type { DmRelayPort } from './dmService';
import { DEFAULT_RELAYS, type WebSocketLike } from './nostr';

export interface WsDmRelayOpts {
  relays?: string[];
  wsFactory?: (url: string) => WebSocketLike;
  /** First-OK deadline for a publish, ms. Default 5000 (was 10000, sequential). */
  publishTimeoutMs?: number;
  /** Base reconnect delay after a subscription socket drops, ms. Default 1000. */
  reconnectMs?: number;
  /** Cap for the exponential reconnect backoff, ms. Default 30000. */
  reconnectMaxMs?: number;
}

interface NostrDmEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export function dmEnvelopeToNostrEvent(envelope: DmEnvelope): NostrDmEvent {
  const keys = schnorr.utils.randomPrivateKey();
  const pubkey = dmToHex(schnorr.getPublicKey(keys));
  const tags = [['p', envelope.recipientHex]];
  const content = JSON.stringify(envelope);
  const idBytes = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, envelope.createdAt, 1059, tags, content])));
  return {
    id: dmToHex(idBytes),
    pubkey,
    created_at: envelope.createdAt,
    kind: 1059,
    tags,
    content,
    sig: dmToHex(schnorr.sign(idBytes, keys)),
  };
}

export function nostrEventToDmEnvelope(event: NostrDmEvent): DmEnvelope | null {
  if (event.kind !== 1059) return null;
  try {
    const envelope = JSON.parse(event.content) as DmEnvelope;
    if (
      typeof envelope.ephemeralPubkeyHex !== 'string' ||
      typeof envelope.recipientHex !== 'string' ||
      typeof envelope.sealed !== 'string'
    ) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
}

/** Per-relay health, best first (most OKs, then lowest last OK latency). */
export interface DmRelayHealth {
  url: string;
  ok: number;
  failed: number;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
}

interface OkWaiter {
  onOk: (url: string, latencyMs: number) => void;
  onRelayDone: (url: string) => void;
  sentAtMs: Map<string, number>;
}

interface PoolEntry {
  ws: WebSocketLike | null;
  state: 'connecting' | 'open' | 'closed';
  openWaiters: Set<() => void>;
  closeWaiters: Set<() => void>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class WsDmRelay implements DmRelayPort {
  private readonly relays: string[];
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly publishTimeoutMs: number;
  private readonly reconnectMs: number;
  private readonly reconnectMaxMs: number;
  private readonly pool = new Map<string, PoolEntry>();
  private readonly health = new Map<string, DmRelayHealth>();
  private readonly okWaiters = new Map<string, OkWaiter>();
  private subOwnHex: string | null = null;
  private subCb: ((e: DmEnvelope) => void) | null = null;
  private subActive = false;
  private lastSeenCreatedAtSec: number | null = null;

  constructor(opts: WsDmRelayOpts = {}) {
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    this.wsFactory =
      opts.wsFactory ??
      ((url: string) => {
        const WS = (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket;
        return new WS(url);
      });
    this.publishTimeoutMs = opts.publishTimeoutMs ?? 5000;
    this.reconnectMs = opts.reconnectMs ?? 1000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30000;
    for (const url of this.relays) {
      this.health.set(url, { url, ok: 0, failed: 0, consecutiveFailures: 0, lastLatencyMs: null });
    }
  }

  get relayUrls(): string[] {
    return [...this.relays];
  }

  /** Per-relay health, best first. A slow relay loses the race; it is not excluded. */
  relayHealth(): DmRelayHealth[] {
    return [...this.health.values()]
      .map(h => ({ ...h }))
      .sort((a, b) => b.ok - a.ok || (a.lastLatencyMs ?? Infinity) - (b.lastLatencyMs ?? Infinity));
  }

  private healthOf(url: string): DmRelayHealth {
    let h = this.health.get(url);
    if (!h) {
      h = { url, ok: 0, failed: 0, consecutiveFailures: 0, lastLatencyMs: null };
      this.health.set(url, h);
    }
    return h;
  }

  private noteOk(url: string, latencyMs: number): void {
    const h = this.healthOf(url);
    h.ok += 1;
    h.consecutiveFailures = 0;
    h.lastLatencyMs = latencyMs;
  }

  private noteFailed(url: string): void {
    const h = this.healthOf(url);
    h.failed += 1;
    h.consecutiveFailures += 1;
  }

  private entryFor(url: string): PoolEntry {
    let entry = this.pool.get(url);
    if (!entry) {
      entry = { ws: null, state: 'closed', openWaiters: new Set(), closeWaiters: new Set(), reconnectAttempts: 0, reconnectTimer: null };
      this.pool.set(url, entry);
    }
    return entry;
  }

  /** Open (or reuse) the pooled socket for a relay. Idempotent. */
  private connect(url: string): PoolEntry {
    const entry = this.entryFor(url);
    if (entry.state === 'open' || entry.state === 'connecting') return entry;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    entry.state = 'connecting';
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(url);
    } catch {
      entry.state = 'closed';
      this.noteFailed(url);
      this.scheduleReconnect(url);
      return entry;
    }
    entry.ws = ws;
    ws.onopen = () => {
      entry.state = 'open';
      entry.reconnectAttempts = 0;
      for (const w of [...entry.openWaiters]) w();
      entry.openWaiters.clear();
      if (this.subActive && this.subOwnHex) this.sendSubscription(url);
    };
    ws.onmessage = ev => {
      try {
        this.handleMessage(url, ev.data);
      } catch {
        // Malformed relay frame: ignore, never crash.
      }
    };
    const onGone = () => {
      if (entry.state === 'closed') return;
      entry.state = 'closed';
      entry.ws = null;
      for (const w of [...entry.closeWaiters]) w();
      entry.closeWaiters.clear();
      for (const w of [...entry.openWaiters]) w();
      entry.openWaiters.clear();
      this.failWaitersOnRelay(url);
      if (this.subActive) this.scheduleReconnect(url);
    };
    ws.onerror = () => {
      onGone();
    };
    ws.onclose = () => {
      onGone();
    };
    return entry;
  }

  private scheduleReconnect(url: string): void {
    if (!this.subActive) return;
    const entry = this.entryFor(url);
    if (entry.reconnectTimer) return;
    const delay = Math.min(this.reconnectMs * 2 ** entry.reconnectAttempts, this.reconnectMaxMs);
    entry.reconnectAttempts += 1;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (this.subActive) this.connect(url);
    }, delay);
  }

  private sendSubscription(url: string): void {
    const entry = this.entryFor(url);
    const ws = entry.ws;
    if (!ws || entry.state !== 'open' || !this.subOwnHex) return;
    const filter: Record<string, unknown> = { kinds: [1059], '#p': [this.subOwnHex] };
    if (this.lastSeenCreatedAtSec !== null) filter.since = this.lastSeenCreatedAtSec;
    try {
      ws.send(JSON.stringify(['REQ', `dm-${this.subOwnHex.slice(0, 8)}`, filter]));
    } catch {
      // Relay reconnect is the transport's job, not this sub's.
    }
  }

  private handleMessage(url: string, data: string): void {
    const parsed = JSON.parse(data) as unknown[];
    if (parsed[0] === 'OK' && typeof parsed[1] === 'string') {
      const waiter = this.okWaiters.get(parsed[1]);
      if (!waiter) return;
      if (parsed[2] === true) {
        const sentAt = waiter.sentAtMs.get(url);
        const latency = sentAt !== undefined ? Date.now() - sentAt : 0;
        this.noteOk(url, latency);
        waiter.onOk(url, latency);
      } else {
        this.noteFailed(url);
        waiter.onRelayDone(url);
      }
      return;
    }
    if (parsed[0] === 'EVENT' && this.subActive && this.subOwnHex && this.subCb) {
      // Delivered at once: EOSE is a backfill signal, never a gate.
      const envelope = nostrEventToDmEnvelope(parsed[2] as NostrDmEvent);
      if (envelope && envelope.recipientHex === this.subOwnHex) {
        if (this.lastSeenCreatedAtSec === null || envelope.createdAt > this.lastSeenCreatedAtSec) {
          this.lastSeenCreatedAtSec = envelope.createdAt;
        }
        this.subCb(envelope);
      }
      return;
    }
    // EOSE and anything else: no action. EOSE never gates delivery.
  }

  private failWaitersOnRelay(url: string): void {
    for (const waiter of [...this.okWaiters.values()]) {
      if (waiter.sentAtMs.has(url)) waiter.onRelayDone(url);
    }
  }

  private waitOpen(entry: PoolEntry): Promise<boolean> {
    if (entry.state === 'open') return Promise.resolve(true);
    if (entry.state === 'closed') return Promise.resolve(false);
    return new Promise(resolve => {
      const onDone = () => {
        entry.openWaiters.delete(onDone);
        entry.closeWaiters.delete(onDone);
        resolve(entry.state === 'open');
      };
      entry.openWaiters.add(onDone);
      entry.closeWaiters.add(onDone);
    });
  }

  /**
   * Publish in parallel to all relays; true on the FIRST relay OK, false
   * when every relay has failed/rejected or the deadline expires. Pooled
   * sockets are reused across sends; a socket that is still connecting
   * is waited on only until the same deadline.
   */
  async publish(envelope: DmEnvelope): Promise<boolean> {
    const event = dmEnvelopeToNostrEvent(envelope);
    const message = JSON.stringify(['EVENT', event]);
    if (this.relays.length === 0) return false;
    return new Promise<boolean>(resolve => {
      let settled = false;
      let settledRelays = 0;
      const doneUrls = new Set<string>();
      const waiter: OkWaiter = {
        sentAtMs: new Map(),
        onOk: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.okWaiters.delete(event.id);
          resolve(true);
        },
        onRelayDone: (url: string) => {
          if (doneUrls.has(url)) return;
          doneUrls.add(url);
          settledRelays += 1;
          if (!settled && settledRelays >= this.relays.length) {
            settled = true;
            clearTimeout(timer);
            this.okWaiters.delete(event.id);
            resolve(false);
          }
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.okWaiters.delete(event.id);
        resolve(false);
      }, this.publishTimeoutMs);
      this.okWaiters.set(event.id, waiter);
      for (const url of this.relays) {
        void (async () => {
          const entry = this.connect(url);
          const open = await this.waitOpen(entry);
          if (settled) return;
          if (!open || !entry.ws) {
            this.noteFailed(url);
            waiter.onRelayDone(url);
            return;
          }
          try {
            entry.ws.send(message);
            waiter.sentAtMs.set(url, Date.now());
          } catch {
            this.noteFailed(url);
            waiter.onRelayDone(url);
          }
        })();
      }
    });
  }

  /**
   * Open one pooled subscription per relay for kind-1059 events addressed
   * to ownHex, held across drops: a dropped socket reconnects with
   * backoff and re-sends its REQ with a since backfill. The returned
   * function stops the subscription and closes the pooled sockets.
   */
  subscribe(ownMeshHex: string, onEnvelope: (e: DmEnvelope) => void): () => void {
    this.subOwnHex = ownMeshHex;
    this.subCb = onEnvelope;
    this.subActive = true;
    this.lastSeenCreatedAtSec = null;
    for (const url of this.relays) this.connect(url);
    return () => {
      this.subActive = false;
      this.subOwnHex = null;
      this.subCb = null;
      for (const entry of this.pool.values()) {
        if (entry.reconnectTimer) {
          clearTimeout(entry.reconnectTimer);
          entry.reconnectTimer = null;
        }
        const ws = entry.ws;
        entry.ws = null;
        entry.state = 'closed';
        if (ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      }
    };
  }
}
