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
// Delivery acks use a second, Airplane-private kind (1060) with the same
// event construction and the same sealed-envelope content shape. The kind
// split is the interop boundary: installs that predate acks subscribe only
// to 1059, so they never receive an ack event and can never mistake one
// for a message. New installs subscribe to both kinds and route acks to
// the ack callback, never to the message path.
//
// Publish model (replacing the old sequential path, which opened a fresh
// socket per relay per send and waited up to 10 s per relay, in order, so
// one slow or rejecting relay stalled a DM for up to 40 s across the four
// default relays, and an explicit relay rejection still burned the full
// 10 s because only OK=true was handled):
// * one pooled socket per relay, held across sends and reused;
// * parallel publish to all relays with a first-OK deadline (default
//   5 s): the first relay OK wins, an explicit OK=false settles that
//   relay as rejected at once instead of burning the deadline, and a
//   slow relay never makes a DM feel slow;
// * a live subscription held across drops: on close the socket reconnects
//   with bounded exponential backoff and re-sends its REQ, with a `since`
//   backfill from the last envelope seen (minus a 300 s overlap), so gaps
//   are fetched, not lost. EOSE is never a gate: EVENT frames are
//   delivered the moment they arrive, before or after any EOSE frame.
// * a half-open socket (neither error nor close, just silent) is
//   detected by a 90 second silence timer, ported from the post
//   transport: any inbound frame resets it, and a silent socket is
//   force-closed and reconnected, which re-sends the REQ with
//   backfill. No ping is attempted: React Native WebSocket exposes
//   no ping, so the post transport ping grace is deliberately not
//   ported. A relay CLOSED for the live subscription triggers an
//   immediate resubscribe on the same sockets, also with backfill.
//   The app layer foreground refresh remains as a backstop.
// * NIP-42 AUTH is not answered here: a relay that challenges with AUTH
//   simply never delivers on that socket, and the other relays still do.
//   Answering challenges is a follow-up (it needs a stable signing
//   identity, and DM send keys are ephemeral by design).

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { isDuplicateRejection } from './balancer';
import { dmFromHex, dmToHex, type DmEnvelope } from './dm';
import type { DmRelayPort, DmRelayPublishResult, DmRelaySubscribeOpts } from './dmService';
import { DEFAULT_RELAYS, type WebSocketLike } from './nostr';
import { sanitizeRelayList } from './relayUrls';

/** Nostr kind for DM messages (NIP-17 gift-wrap-shaped). */
export const DM_EVENT_KIND = 1059;
/**
 * Airplane-private Nostr kind for delivery acks. Not a standard Nostr
 * kind: it exists only so old installs (1059-only subscriptions) never
 * receive acks. Relays store and forward arbitrary kinds.
 */
export const DM_ACK_EVENT_KIND = 1060;

/** Silence interval for DM pool sockets, ms. Ported from the post transport. */
export const DM_SILENCE_TIMEOUT_MS = 90000;

export interface WsDmRelayOpts {
  relays?: string[];
  wsFactory?: (url: string) => WebSocketLike;
  /** First-OK deadline for a publish, ms. Default 5000. */
  publishTimeoutMs?: number;
  /** Base reconnect delay after a subscription socket drops, ms. Default 1000. */
  reconnectMs?: number;
  /** Cap for the exponential reconnect backoff, ms. Default 30000. */
  reconnectMaxMs?: number;
  /**
   * Silence interval, ms. Default 90000. A socket that receives no
   * frame for this long is force-closed and reconnected. No ping is
   * sent first: React Native WebSocket exposes no ping.
   */
  silenceTimeoutMs?: number;
  /** Allow private-network relay targets (explicit user-added list). */
  allowPrivateRelays?: boolean;
  /** A pooled socket opened (relay URL). The app uses it to re-attempt queued work. */
  onSocketOpen?: (relayUrl: string) => void;
  /** A pooled socket closed, with the reason ('error', 'closed', 'silence timeout'). */
  onSocketClosed?: (relayUrl: string, reason: string) => void;
  /** A connect attempt failed before any socket existed (relay URL, reason). */
  onConnectFailure?: (relayUrl: string, reason: string) => void;
  /** A reconnect was scheduled, with the delay and the attempt number (1-based). */
  onReconnectScheduled?: (relayUrl: string, delayMs: number, attempt: number) => void;
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

function buildNostrEvent(envelope: DmEnvelope, kind: number): NostrDmEvent {
  const keys = schnorr.utils.randomPrivateKey();
  const pubkey = dmToHex(schnorr.getPublicKey(keys));
  const tags = [['p', envelope.recipientHex]];
  const content = JSON.stringify(envelope);
  const idBytes = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, envelope.createdAt, kind, tags, content])));
  return {
    id: dmToHex(idBytes),
    pubkey,
    created_at: envelope.createdAt,
    kind,
    tags,
    content,
    sig: dmToHex(schnorr.sign(idBytes, keys)),
  };
}

export function dmEnvelopeToNostrEvent(envelope: DmEnvelope): NostrDmEvent {
  return buildNostrEvent(envelope, DM_EVENT_KIND);
}

/** Ack events use the ack kind; everything else is identical to a DM event. */
export function dmAckEnvelopeToNostrEvent(envelope: DmEnvelope): NostrDmEvent {
  return buildNostrEvent(envelope, DM_ACK_EVENT_KIND);
}

function nostrEventToEnvelope(event: NostrDmEvent, kind: number): DmEnvelope | null {
  if (event.kind !== kind) return null;
  try {
    const envelope = JSON.parse(event.content) as DmEnvelope;
    if (
      typeof envelope.ephemeralPubkeyHex !== 'string' ||
      typeof envelope.recipientHex !== 'string' ||
      typeof envelope.sealed !== 'string'
    ) {
      return null;
    }
    // The event's own p tag must name the envelope recipient: a relay
    // must not be able to re-address an event to a different recipient.
    if (
      !Array.isArray(event.tags) ||
      !event.tags.some(tag => tag[0] === 'p' && tag[1] === envelope.recipientHex)
    ) {
      return null;
    }
    // Verify the Nostr id and schnorr signature with the same construction
    // the sender used, so a relay cannot forge 1059 events claiming any
    // sender. This stops relay forgery, not peer forgery by a party that
    // seals correctly (that needs the separate sender-auth protocol fix).
    if (typeof event.created_at !== 'number') return null;
    const pubkeyBytes = dmFromHex(event.pubkey);
    const idBytes = dmFromHex(event.id);
    const sigBytes = dmFromHex(event.sig);
    if (!pubkeyBytes || pubkeyBytes.length !== 32) return null;
    if (!idBytes || idBytes.length !== 32) return null;
    if (!sigBytes || sigBytes.length !== 64) return null;
    const expectedId = sha256(
      new TextEncoder().encode(JSON.stringify([0, event.pubkey, event.created_at, kind, event.tags, event.content])),
    );
    if (dmToHex(expectedId) !== event.id) return null;
    if (!schnorr.verify(sigBytes, idBytes, pubkeyBytes)) return null;
    envelope.relayEventId = event.id;
    return envelope;
  } catch {
    return null;
  }
}

export function nostrEventToDmEnvelope(event: NostrDmEvent): DmEnvelope | null {
  return nostrEventToEnvelope(event, DM_EVENT_KIND);
}

export function nostrEventToDmAckEnvelope(event: NostrDmEvent): DmEnvelope | null {
  return nostrEventToEnvelope(event, DM_ACK_EVENT_KIND);
}

interface PublishWaiter {
  eventId: string;
  resolve: (r: DmRelayPublishResult) => void;
  /** Per-relay outcome once settled: 'ok', 'rejected', or 'failed'. */
  settled: Map<string, 'ok' | 'rejected' | 'failed'>;
  /** The relay's own rejection reason per URL (NIP-01 OK element 3). */
  rejectionReasons: Map<string, string>;
  done: boolean;
}

interface PoolEntry {
  ws: WebSocketLike | null;
  state: 'connecting' | 'open' | 'closed';
  openWaiters: Set<() => void>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class WsDmRelay implements DmRelayPort {
  private readonly relays: string[];
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly publishTimeoutMs: number;
  private readonly reconnectMs: number;
  private readonly reconnectMaxMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly onSocketOpen: WsDmRelayOpts['onSocketOpen'];
  private readonly onSocketClosed: WsDmRelayOpts['onSocketClosed'];
  private readonly onConnectFailure: WsDmRelayOpts['onConnectFailure'];
  private readonly onReconnectScheduled: WsDmRelayOpts['onReconnectScheduled'];
  /** Last inbound frame time per relay (liveness proof for silence detection). */
  private readonly lastFrameAtMs = new Map<string, number>();
  /** Armed silence timer per relay. */
  private readonly silenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pool = new Map<string, PoolEntry>();
  private readonly publishWaiters = new Set<PublishWaiter>();
  /**
   * First-built Nostr event per envelope, keyed by kind + envelope bytes.
   * A retry publishes the identical event (same id, same ephemeral key)
   * instead of minting a fresh event id, so relays and the inbound dedup
   * see one logical send. Bounded with oldest eviction; the envelope's
   * ephemeral pubkey already makes each logical send a distinct key.
   */
  private readonly eventCache = new Map<string, { id: string; message: string }>();
  private subActive = false;
  private subOwnHex: string | null = null;
  private subCb: ((e: DmEnvelope) => void) | null = null;
  private subAckCb: ((e: DmEnvelope) => void) | null = null;
  private subId = '';
  /** Earliest `since` ever used for this subscription (the first-subscribe window). */
  private subSinceSec: number | null = null;
  /** Created_at of the newest DM or ack event seen on this subscription. */
  private lastSeenCreatedAtSec: number | null = null;

  constructor(opts: WsDmRelayOpts = {}) {
    this.relays =
      opts.relays === undefined
        ? [...DEFAULT_RELAYS]
        : sanitizeRelayList(opts.relays, { allowPrivateRelays: opts.allowPrivateRelays });
    this.wsFactory =
      opts.wsFactory ??
      ((url: string) => {
        const WS = (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket;
        return new WS(url);
      });
    this.publishTimeoutMs = opts.publishTimeoutMs ?? 5000;
    this.reconnectMs = opts.reconnectMs ?? 1000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30000;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? DM_SILENCE_TIMEOUT_MS;
    this.onSocketOpen = opts.onSocketOpen;
    this.onSocketClosed = opts.onSocketClosed;
    this.onConnectFailure = opts.onConnectFailure;
    this.onReconnectScheduled = opts.onReconnectScheduled;
  }

  /** Relay URLs this pool manages. */
  getRelayUrls(): string[] {
    return [...this.relays];
  }

  /** Current per-relay connection state. */
  getRelayState(url: string): 'open' | 'connecting' | 'closed' {
    return this.pool.get(url)?.state ?? 'closed';
  }

  /** Count of relays with an open socket right now. */
  openRelayCount(): number {
    let open = 0;
    for (const entry of this.pool.values()) if (entry.state === 'open') open += 1;
    return open;
  }

  /** Arm (or re-arm) the silence timer for one relay. */
  private armSilenceTimer(url: string): void {
    const old = this.silenceTimers.get(url);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.silenceTimers.delete(url);
      this.onSilenceTimeout(url);
    }, this.silenceTimeoutMs);
    // In Node (tests) an unrefed timer must not hold the process open
    // for the full silence window after a test ends. React Native
    // timers have no unref, so this is a no-op there.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.silenceTimers.set(url, timer);
  }

  private clearSilenceTimer(url: string): void {
    const timer = this.silenceTimers.get(url);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimers.delete(url);
    }
  }

  /**
   * A relay went silent: force-close and let the normal drop path
   * reconnect it (which re-sends the subscription with backfill).
   * No ping grace: the platform WebSocket cannot send a ping, so a
   * grace would only delay the recovery the timer exists to provide.
   * A frame that arrived after the timer was armed but before it
   * fired re-arms instead of closing a live socket.
   */
  private onSilenceTimeout(url: string): void {
    const entry = this.pool.get(url);
    if (!entry || !entry.ws) return;
    const last = this.lastFrameAtMs.get(url) ?? 0;
    if (Date.now() - last < this.silenceTimeoutMs) {
      this.armSilenceTimer(url);
      return;
    }
    const ws = entry.ws;
    try {
      ws.close();
    } catch {
      // fall through to the direct drop below
    }
    // If close did not fire onclose (some implementations do not),
    // run the drop path directly so the relay is not left stale.
    // When onclose already ran, entry.ws is null and drop is a no-op
    // for this socket, because drop checks entry.ws identity first.
    // The drop closure lives inside connect(); this method therefore
    // only closes here, and the reconnect is driven by onclose or by
    // the next publish/subscribe connect. To guarantee reconnect
    // even without onclose, re-drive connect through the pool entry
    // state below.
    if (entry.ws === ws) {
      entry.state = 'closed';
      entry.ws = null;
      this.clearSilenceTimer(url);
      for (const w of [...entry.openWaiters]) w();
      entry.openWaiters.clear();
      this.onSocketClosed?.(url, 'silence timeout');
      for (const waiter of [...this.publishWaiters]) {
        if (waiter.done || waiter.settled.has(url)) continue;
        waiter.settled.set(url, 'failed');
        if (waiter.settled.size >= this.relays.length) {
          waiter.resolve({ accepted: false, rejected: false });
        }
      }
      if (this.subActive) this.scheduleReconnect(url);
    }
  }

  /** Publish to relays in parallel; true when ANY relay answers OK. */
  async publish(envelope: DmEnvelope): Promise<DmRelayPublishResult> {
    return this.publishEvent(envelope, DM_EVENT_KIND);
  }

  /** Publish a delivery ack event (ack kind, same construction). */
  async publishAck(envelope: DmEnvelope): Promise<DmRelayPublishResult> {
    return this.publishEvent(envelope, DM_ACK_EVENT_KIND);
  }

  private async publishEvent(envelope: DmEnvelope, kind: number): Promise<DmRelayPublishResult> {
    const key = `${kind}:${JSON.stringify(envelope)}`;
    let cached = this.eventCache.get(key);
    if (!cached) {
      const event = buildNostrEvent(envelope, kind);
      cached = { id: event.id, message: JSON.stringify(['EVENT', event]) };
      if (this.eventCache.size >= 500) {
        const oldest = this.eventCache.keys().next();
        if (!oldest.done) this.eventCache.delete(oldest.value);
      }
      this.eventCache.set(key, cached);
    }
    const { id: eventId, message } = cached;
    return new Promise<DmRelayPublishResult>(resolve => {
      const waiter: PublishWaiter = {
        eventId,
        resolve: (r: DmRelayPublishResult) => {
          if (waiter.done) return;
          waiter.done = true;
          clearTimeout(timer);
          this.publishWaiters.delete(waiter);
          resolve(r);
        },
        settled: new Map(),
        rejectionReasons: new Map(),
        done: false,
      };
      this.publishWaiters.add(waiter);
      const firstReason = (): string | undefined => {
        for (const reason of waiter.rejectionReasons.values()) {
          if (reason) return reason;
        }
        return undefined;
      };
      const timer = setTimeout(() => {
        if (waiter.done) return;
        const rejected = [...waiter.settled.values()].some(v => v === 'rejected');
        waiter.resolve({ accepted: false, rejected, reason: firstReason() });
      }, this.publishTimeoutMs);
      const settle = (url: string, outcome: 'ok' | 'rejected' | 'failed'): void => {
        if (waiter.done) return;
        if (waiter.settled.has(url)) return;
        waiter.settled.set(url, outcome);
        if (outcome === 'ok') {
          waiter.resolve({ accepted: true, rejected: false });
          return;
        }
        if (waiter.settled.size >= this.relays.length) {
          const rejected = [...waiter.settled.values()].some(v => v === 'rejected');
          waiter.resolve({ accepted: false, rejected, reason: firstReason() });
        }
      };
      if (this.relays.length === 0) {
        waiter.resolve({ accepted: false, rejected: false });
        return;
      }
      for (const url of this.relays) {
        void this.publishToRelay(url, message, waiter, settle, timer);
      }
    });
  }

  private async publishToRelay(
    url: string,
    message: string,
    waiter: PublishWaiter,
    settle: (url: string, outcome: 'ok' | 'rejected' | 'failed') => void,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    const entry = this.connect(url);
    if (entry.state === 'open' && entry.ws) {
      try {
        entry.ws.send(message);
      } catch {
        settle(url, 'failed');
      }
      return;
    }
    if (entry.state === 'closed') {
      // Factory threw or the socket died before publish: no wait, this
      // relay is failed for this publish (a later publish retries it).
      settle(url, 'failed');
      return;
    }
    // Connecting: wait for open, bounded by the publish deadline. The
    // deadline timer lives on the waiter; polling the remaining time
    // here keeps the wait from outliving it.
    const deadline = Date.now() + this.publishTimeoutMs;
    let check: () => void = () => {};
    await new Promise<void>(r => {
      check = (): void => {
        if (waiter.done) {
          r();
          return;
        }
        if (entry.state === 'open') {
          r();
          return;
        }
        if (entry.state === 'closed' || Date.now() >= deadline) {
          r();
          return;
        }
        setTimeout(check, 25);
      };
      entry.openWaiters.add(check);
      check();
    });
    entry.openWaiters.delete(check);
    if (waiter.done) return;
    if (entry.state === 'open' && entry.ws) {
      try {
        entry.ws.send(message);
      } catch {
        settle(url, 'failed');
      }
    } else if (!waiter.settled.has(url)) {
      settle(url, 'failed');
    }
    void timer;
  }

  private entryFor(url: string): PoolEntry {
    let entry = this.pool.get(url);
    if (!entry) {
      entry = { ws: null, state: 'closed', openWaiters: new Set(), reconnectAttempts: 0, reconnectTimer: null };
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
    } catch (err) {
      entry.state = 'closed';
      this.onConnectFailure?.(url, err instanceof Error ? err.message : String(err));
      this.scheduleReconnect(url);
      return entry;
    }
    entry.ws = ws;
    this.lastFrameAtMs.set(url, Date.now());
    this.armSilenceTimer(url);
    ws.onopen = () => {
      entry.state = 'open';
      entry.reconnectAttempts = 0;
      this.lastFrameAtMs.set(url, Date.now());
      this.armSilenceTimer(url);
      for (const w of [...entry.openWaiters]) w();
      entry.openWaiters.clear();
      this.onSocketOpen?.(url);
      if (this.subActive) this.sendSubscription(url);
    };
    ws.onmessage = ev => {
      // Any frame proves the socket is alive: reset the silence window
      // before parsing, so a malformed frame still counts as liveness.
      this.lastFrameAtMs.set(url, Date.now());
      this.armSilenceTimer(url);
      try {
        const data = JSON.parse(String(ev.data)) as unknown[];
        if (data[0] === 'OK' && typeof data[1] === 'string') {
          for (const waiter of [...this.publishWaiters]) {
            if (waiter.eventId !== data[1]) continue;
            // The relay's own reason is OK element 3: keep it, so a
            // rejection is diagnosable instead of generic.
            const reason = typeof data[3] === 'string' ? data[3].slice(0, 200) : '';
            if (data[2] === true) {
              waiter.settled.set(url, 'ok');
              waiter.resolve({ accepted: true, rejected: false });
            } else if (isDuplicateRejection(reason)) {
              // "duplicate:" means the relay already holds the envelope:
              // stored, not failed. Accept at once like a fresh OK; the
              // recipient fetches it the same way. Before v0.1.27 this
              // burned a re-publish attempt toward Failed.
              waiter.settled.set(url, 'ok');
              waiter.resolve({ accepted: true, rejected: false, reason, duplicate: true });
            } else {
              // Explicit rejection: settle this relay at once. The old
              // code ignored OK=false and burned the full timeout here.
              waiter.settled.set(url, 'rejected');
              waiter.rejectionReasons.set(url, reason);
              if (waiter.settled.size >= this.relays.length) {
                waiter.resolve({ accepted: false, rejected: true, reason });
              }
            }
          }
          return;
        }
        if (data[0] === 'EVENT' && data[1] === this.subId && this.subActive && data[2]) {
          const event = data[2] as NostrDmEvent;
          if (event.kind === DM_EVENT_KIND) {
            const envelope = nostrEventToDmEnvelope(event);
            if (envelope && envelope.recipientHex === this.subOwnHex) {
              if (typeof event.created_at === 'number') {
                this.lastSeenCreatedAtSec = Math.max(this.lastSeenCreatedAtSec ?? 0, event.created_at);
              }
              this.subCb?.(envelope);
            }
          } else if (event.kind === DM_ACK_EVENT_KIND) {
            const envelope = nostrEventToDmAckEnvelope(event);
            if (envelope && envelope.recipientHex === this.subOwnHex) {
              if (typeof event.created_at === 'number') {
                this.lastSeenCreatedAtSec = Math.max(this.lastSeenCreatedAtSec ?? 0, event.created_at);
              }
              this.subAckCb?.(envelope);
            }
          }
        }
        if (data[0] === 'CLOSED' && this.subActive && data[1] === this.subId) {
          // The relay killed the live subscription: resubscribe at once
          // on every open socket. sendSubscription replays from the
          // last envelope or ack seen minus overlap, so the gap
          // replays instead of staying missed. This is the immediate
          // recovery; the app foreground refresh stays as backstop.
          for (const relayUrl of this.relays) this.sendSubscription(relayUrl);
        }
        // EOSE, NOTICE, AUTH: never gate delivery, never crash.
      } catch {
        // Malformed relay frame: ignore, never crash.
      }
    };
    const drop = (reason: string): void => {
      if (entry.ws !== ws) return;
      entry.state = 'closed';
      entry.ws = null;
      this.clearSilenceTimer(url);
      for (const w of [...entry.openWaiters]) w();
      entry.openWaiters.clear();
      // Close the dead socket itself (a second close is a no-op, and a
      // re-entrant onclose here returns early on the ws mismatch above).
      try {
        ws.close();
      } catch {
        // ignore
      }
      this.onSocketClosed?.(url, reason);
      // In-flight publishes on this socket settle as failed (never as
      // rejected: a drop is not a relay judgement).
      for (const waiter of [...this.publishWaiters]) {
        if (waiter.done || waiter.settled.has(url)) continue;
        waiter.settled.set(url, 'failed');
        if (waiter.settled.size >= this.relays.length) {
          waiter.resolve({ accepted: false, rejected: false });
        }
      }
      if (this.subActive) this.scheduleReconnect(url);
    };
    ws.onerror = () => {
      drop('error');
    };
    ws.onclose = () => {
      drop('closed');
    };
    return entry;
  }

  private scheduleReconnect(url: string): void {
    const entry = this.entryFor(url);
    if (entry.reconnectTimer) return;
    const delay = Math.min(this.reconnectMs * 2 ** entry.reconnectAttempts, this.reconnectMaxMs);
    entry.reconnectAttempts += 1;
    this.onReconnectScheduled?.(url, delay, entry.reconnectAttempts);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (!this.subActive) return;
      this.connect(url);
    }, delay);
  }

  private sendSubscription(url: string): void {
    const entry = this.pool.get(url);
    if (!entry || entry.state !== 'open' || !entry.ws || !this.subActive || !this.subOwnHex) return;
    // A reconnect replays from the last envelope seen (minus overlap),
    // not from the first-subscribe window: the gap, not the history.
    const since =
      this.lastSeenCreatedAtSec !== null
        ? this.lastSeenCreatedAtSec - 300
        : (this.subSinceSec ?? Math.floor(Date.now() / 1000) - 86400);
    const filter = JSON.stringify({
      kinds: [DM_EVENT_KIND, DM_ACK_EVENT_KIND],
      '#p': [this.subOwnHex],
      since,
    });
    try {
      entry.ws.send(JSON.stringify(['REQ', this.subId, JSON.parse(filter)]));
    } catch {
      // A drop here surfaces via onerror/onclose and reconnects.
    }
  }

  /**
   * Subscribe for kind-1059 DMs and kind-1060 acks addressed to ownHex.
   * Re-subscribing replaces the previous subscription (same sockets, new
   * REQ): no duplicate sockets, no duplicate EVENT delivery, because the
   * message handler routes only to the current callbacks. Unsubscribe
   * stops EVENT routing but keeps the pooled sockets for publish.
   */
  subscribe(
    ownMeshHex: string,
    onEnvelope: (e: DmEnvelope) => void,
    onAck?: (e: DmEnvelope) => void,
    opts?: DmRelaySubscribeOpts,
  ): () => void {
    this.subActive = true;
    this.subOwnHex = ownMeshHex;
    this.subCb = onEnvelope;
    this.subAckCb = onAck ?? null;
    this.subId = `dm-${ownMeshHex.slice(0, 8)}`;
    if (opts?.backfillSinceSec !== undefined) {
      this.subSinceSec = opts.backfillSinceSec;
      this.lastSeenCreatedAtSec = null;
    } else if (this.lastSeenCreatedAtSec !== null) {
      // Resubscribe without an explicit window: backfill from the last
      // envelope seen, minus overlap, so a drop gap replays.
      this.subSinceSec = this.lastSeenCreatedAtSec - 300;
    } else if (this.subSinceSec === null) {
      // First subscribe: bounded replay of the last 24 h, not the relay's
      // full stored history. No limit is set: a limit could silently
      // truncate the newest events without an ordering guarantee.
      this.subSinceSec = Math.floor(Date.now() / 1000) - 86400;
    }
    for (const url of this.relays) {
      const entry = this.connect(url);
      if (entry.state === 'open') this.sendSubscription(url);
    }
    return () => {
      this.subActive = false;
      this.subCb = null;
      this.subAckCb = null;
      this.subOwnHex = null;
    };
  }
}
