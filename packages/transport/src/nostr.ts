// SPDX-License-Identifier: Apache-2.0
// Nostr transport: relay WebSocket client + Airplane event wrapper codec.
//
// DESIGN NOTE - why wrap instead of mapping 1:1:
//
// Our SignedEvent uses Ed25519 signatures over a CBOR canonical pre-image
// that includes the geohash. Nostr (NIP-01) requires:
//   id = sha256(JSON([0, pubkey, created_at, kind, tags, content]))
//   sig = schnorr(id) over secp256k1
// Neither the id pre-image nor the signature scheme matches. Rather than
// weaken our protocol, Nostr is used as a *dumb transport*: our complete
// signed CBOR event is embedded (hex) in the content of a well-formed Nostr
// event (kind 30000). The Nostr envelope is signed with an ephemeral
// secp256k1 keypair (transport authenticity only); the inner Ed25519
// signature is verified on unwrap (content authenticity). Relays see valid
// Nostr events; our event IDs stay identical across BLE and Nostr for dedup.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  decodeEvent,
  encodeEvent,
  verifyEvent,
  NobleCrypto,
  toHex,
  fromHex,
  type Hex64,
  type SignedEvent,
} from '@airplane/protocol';

// Lazily-created noble backend for inner signature verification.
let nobleCrypto: NobleCrypto | null = null;
function crypto(): NobleCrypto {
  if (!nobleCrypto) nobleCrypto = new NobleCrypto();
  return nobleCrypto;
}

/** Nostr event kind for wrapped Airplane events (custom range). */
export const AIRPLANE_NOSTR_KIND = 30000;

/** Tag marking the envelope as an Airplane wrapper. */
export const AIRPLANE_TAG = ['airplane', '1'];

/** Default public relays (override via NostrTransportOpts). */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
];

/** A Nostr event per NIP-01 (JSON-serializable). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Nostr keypair (secp256k1); transport-only, NOT the device identity. */
export interface NostrKeypair {
  /** 32-byte secret key. */
  secretKey: Uint8Array;
  /** 32-byte public key (x-only per NIP-01). */
  publicKey: Uint8Array;
}

/** Generate an ephemeral secp256k1 keypair for Nostr transport. */
export function generateNostrKeypair(): NostrKeypair {
  const secretKey = schnorr.utils.randomPrivateKey();
  const publicKey = schnorr.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/** Nostr event id: sha256 of the JSON-serialized [0, pubkey, created_at, kind, tags, content]. */
export function nostrEventId(pubkeyHex: string, createdAt: number, kind: number, tags: string[][], content: string): Uint8Array {
  const serialized = JSON.stringify([0, pubkeyHex, createdAt, kind, tags, content]);
  return sha256(new TextEncoder().encode(serialized));
}

/**
 * Wrap a signed Airplane event in a valid Nostr envelope.
 * The inner event bytes are hex-encoded in `content`; the `e` tag carries
 * our event ID so receivers can dedupe without decoding.
 */
export function wrapEvent(event: SignedEvent, keys: NostrKeypair, createdAtSec?: number): NostrEvent {
  const pubkeyHex = toHex(keys.publicKey);
  const created_at = createdAtSec ?? Math.floor(Date.now() / 1000);
  const eventIdHex = toHex(event.id);
  const tags: string[][] = [
    ['e', eventIdHex],
    ['g', event.geohash],
    [...AIRPLANE_TAG],
  ];
  // Preserve our original tags that don't collide with envelope tags.
  for (const t of event.tags) {
    if (t[0] !== 'e' && t[0] !== 'g' && t[0] !== 'airplane') tags.push(t);
  }
  const content = toHex(encodeEvent(event));
  const idBytes = nostrEventId(pubkeyHex, created_at, AIRPLANE_NOSTR_KIND, tags, content);
  const sig = schnorr.sign(idBytes, keys.secretKey);
  return {
    id: toHex(idBytes),
    pubkey: pubkeyHex,
    created_at,
    kind: AIRPLANE_NOSTR_KIND,
    tags,
    content,
    sig: toHex(sig),
  };
}

/**
 * Unwrap a Nostr event into our SignedEvent. Returns null when the envelope
 * is not an Airplane wrapper, the inner CBOR is malformed, or the inner
 * Ed25519 signature is invalid. The Nostr envelope signature is NOT verified
 * here (transport authenticity is the relay's concern); the inner signature
 * is what matters.
 */
export function unwrapEvent(nostr: NostrEvent): SignedEvent | null {
  if (nostr.kind !== AIRPLANE_NOSTR_KIND) return null;
  if (!nostr.tags.some((t) => t[0] === 'airplane' && t[1] === '1')) return null;
  let event: SignedEvent;
  try {
    event = decodeEvent(fromHex(nostr.content));
  } catch {
    return null;
  }
  // Verify the inner Ed25519 signature - a relay (or MITM) must not be able
  // to forge or tamper with the wrapped event.
  if (!verifyEvent(crypto(), event)) return null;
  return event;
}

/** Nostr client message types we send. */
type ClientMsg = ['EVENT', NostrEvent] | ['REQ', string, object] | ['CLOSE', string];

/** Minimal WebSocket surface (injectable for tests; global WebSocket on device). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface NostrTransportOpts {
  /** Relay WebSocket URLs. Defaults to DEFAULT_RELAYS. */
  relays?: string[];
  /** WebSocket factory. Defaults to global WebSocket (device). */
  wsFactory?: WebSocketFactory;
  /** Nostr keypair for the envelope. Defaults to ephemeral. */
  keys?: NostrKeypair;
  /**
   * Base reconnect delay after a drop, ms. Default 5000. Grows
   * exponentially with each consecutive failure, capped at
   * `reconnectMaxMs`, with ±20% jitter to avoid thundering herds.
   */
  reconnectMs?: number;
  /** Cap for the exponential reconnect backoff, ms. Default 60000. */
  reconnectMaxMs?: number;
}

/** Connection state per relay. */
export type RelayState = 'connecting' | 'open' | 'closed';

/** Result of a publish that waits for relay acknowledgement. */
export interface RelayPublishAck {
  /** Relay URLs that sent an accepted OK for the envelope. */
  ok: string[];
  /** Relay URLs that sent a rejected OK for the envelope. */
  rejected: string[];
  /** True when the deadline expired before any OK arrived. */
  timedOut: boolean;
}

/** One in-flight OK waiter, shared by every concurrent publish of one envelope. */
interface OkWaiter {
  remaining: Set<string>;
  ok: Set<string>;
  rejected: Set<string>;
  resolve: (ack: RelayPublishAck) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Nostr relay client. Connects to multiple relays, publishes wrapped events,
 * subscribes to Airplane-kind events. No Google services; plain WebSocket.
 *
 * Reconnection: on unexpected close, reconnects with bounded exponential
 * backoff (base `reconnectMs`, doubling per consecutive failure, capped at
 * `reconnectMaxMs`, ±20% jitter) while `start()`ed. A successful open resets
 * the per-relay failure count. Call `stop()` to disconnect cleanly.
 */
export class NostrTransport {
  private readonly relays: string[];
  private readonly wsFactory: WebSocketFactory;
  private readonly keys: NostrKeypair;
  private readonly reconnectMs: number;
  private readonly reconnectMaxMs: number;
  private sockets = new Map<string, WebSocketLike>();
  private states = new Map<string, RelayState>();
  private started = false;
  private receiveHandlers = new Set<(event: SignedEvent, relayUrl: string) => void>();
  private subIdCounter = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Consecutive failed connect attempts per relay; reset on open. */
  private reconnectAttempts = new Map<string, number>();
  /** In-flight relay OK waiters, indexed by Nostr envelope id. */
  private okWaiters = new Map<string, Set<OkWaiter>>();
  private allOkWaiters = new Set<OkWaiter>();

  constructor(opts: NostrTransportOpts = {}) {
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    this.wsFactory =
      opts.wsFactory ??
      ((url: string) => {
        const WS = (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket;
        return new WS(url);
      });
    this.keys = opts.keys ?? generateNostrKeypair();
    this.reconnectMs = opts.reconnectMs ?? 5000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 60000;
  }

  /** Relay URLs this transport manages. */
  get relayUrls(): string[] {
    return [...this.relays];
  }

  /** Current per-relay connection state. */
  getRelayState(url: string): RelayState {
    return this.states.get(url) ?? 'closed';
  }

  /** True when at least one relay is open. */
  get online(): boolean {
    for (const s of this.states.values()) if (s === 'open') return true;
    return false;
  }

  /** Connect to all relays. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const url of this.relays) this.connectOne(url);
  }

  /** Disconnect all relays. Idempotent. */
  async stop(): Promise<void> {
    this.started = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.reconnectAttempts.clear();
    // A stop must never leave a publish hanging on an OK that can no
    // longer arrive: resolve every waiter with no OK.
    for (const w of this.allOkWaiters) {
      if (w.timer) clearTimeout(w.timer);
      w.timer = null;
      w.resolve({ ok: [...w.ok], rejected: [...w.rejected], timedOut: false });
    }
    this.allOkWaiters.clear();
    this.okWaiters.clear();
    for (const [url, ws] of this.sockets) {
      this.states.set(url, 'closed');
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    this.sockets.clear();
  }

  private connectOne(url: string): void {
    if (!this.started) return;
    this.states.set(url, 'connecting');
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(url);
    } catch {
      this.scheduleReconnect(url);
      return;
    }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      // A socket that opens after stop() must not resurrect the relay:
      // the transport is stopped, so this open is stale and ignored.
      if (!this.started) return;
      this.states.set(url, 'open');
      // A successful connection resets the backoff - the next drop starts
      // again from the base delay.
      this.reconnectAttempts.delete(url);
      this.resubscribe(ws);
    };
    ws.onmessage = (ev) => this.handleMessage(url, ev.data);
    ws.onerror = () => {
      // onclose follows; reconnect there
    };
    ws.onclose = () => {
      this.sockets.delete(url);
      this.states.set(url, 'closed');
      this.noteRelayGone(url);
      this.scheduleReconnect(url);
    };
  }

  private scheduleReconnect(url: string): void {
    if (!this.started) return;
    const attempts = this.reconnectAttempts.get(url) ?? 0;
    this.reconnectAttempts.set(url, attempts + 1);
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        this.connectOne(url);
      },
      this.backoffDelayMs(attempts),
    );
    this.timers.add(timer);
  }

  /**
   * Bounded exponential backoff: base * 2^attempts, capped at
   * reconnectMaxMs, with ±20% jitter so many phones don't retry in
   * lockstep. `attempts` counts consecutive failures (0 = first retry).
   */
  private backoffDelayMs(attempts: number): number {
    const grown = this.reconnectMs * 2 ** attempts;
    const capped = Math.min(grown, this.reconnectMaxMs);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(1, Math.round(capped * jitter));
  }

  private sendMsg(url: string, msg: ClientMsg): boolean {
    const ws = this.sockets.get(url);
    if (!ws || this.states.get(url) !== 'open') return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Publish one event to all open relays. Returns URLs the envelope was sent to (no acceptance waited for); use publishWithAck when acceptance matters. */
  async publish(event: SignedEvent): Promise<string[]> {
    const envelope = wrapEvent(event, this.keys);
    const msg: ClientMsg = ['EVENT', envelope];
    const ok: string[] = [];
    for (const url of this.relays) {
      if (this.sendMsg(url, msg)) ok.push(url);
    }
    return ok;
  }

  /**
   * Publish one event to all open relays and wait for the first accepted
   * relay OK, up to deadlineMs. First accepted OK resolves immediately;
   * all relays rejecting, all relays dropping, or the deadline expiring
   * resolves with an empty ok list. When no relay socket is open, this
   * resolves immediately without waiting: the caller falls through at
   * once instead of spinning on a relay that is not there. The plain
   * publish() above stays for callers that do not need an OK (WorldSync
   * uplink); the ordered router uses this method.
   */
  async publishWithAck(event: SignedEvent, deadlineMs: number): Promise<RelayPublishAck> {
    const envelope = wrapEvent(event, this.keys);
    const msg: ClientMsg = ['EVENT', envelope];
    const sent: string[] = [];
    for (const url of this.relays) {
      if (this.sendMsg(url, msg)) sent.push(url);
    }
    if (sent.length === 0) return { ok: [], rejected: [], timedOut: false };
    return new Promise<RelayPublishAck>((resolve) => {
      const waiter: OkWaiter = {
        remaining: new Set(sent),
        ok: new Set(),
        rejected: new Set(),
        resolve,
        timer: null,
      };
      const finish = (ack: RelayPublishAck): void => {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          this.timers.delete(waiter.timer);
          waiter.timer = null;
        }
        this.allOkWaiters.delete(waiter);
        const set = this.okWaiters.get(envelope.id);
        if (set) {
          set.delete(waiter);
          if (set.size === 0) this.okWaiters.delete(envelope.id);
        }
        resolve(ack);
      };
      waiter.resolve = (ack) => finish(ack);
      const timer = setTimeout(() => {
        finish({ ok: [...waiter.ok], rejected: [...waiter.rejected], timedOut: true });
      }, deadlineMs);
      waiter.timer = timer;
      this.timers.add(timer);
      let set = this.okWaiters.get(envelope.id);
      if (!set) {
        set = new Set();
        this.okWaiters.set(envelope.id, set);
      }
      set.add(waiter);
      this.allOkWaiters.add(waiter);
    });
  }

  /**
   * A relay socket closed while OK waiters were outstanding: that relay
   * can no longer OK. Waiters with no remaining relay resolve at once
   * instead of waiting out the deadline.
   */
  private noteRelayGone(url: string): void {
    for (const waiter of [...this.allOkWaiters]) {
      if (!waiter.remaining.has(url)) continue;
      waiter.remaining.delete(url);
      if (waiter.remaining.size === 0 && waiter.ok.size === 0) {
        waiter.resolve({ ok: [], rejected: [...waiter.rejected], timedOut: false });
      }
    }
  }

  /** Route one relay OK message to every waiter for that envelope id. */
  private handleOk(relayUrl: string, envelopeId: unknown, accepted: unknown): void {
    if (typeof envelopeId !== 'string' || typeof accepted !== 'boolean') return;
    const waiters = this.okWaiters.get(envelopeId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (!waiter.remaining.has(relayUrl)) continue;
      waiter.remaining.delete(relayUrl);
      if (accepted) {
        waiter.ok.add(relayUrl);
        waiter.resolve({ ok: [...waiter.ok], rejected: [...waiter.rejected], timedOut: false });
      } else {
        waiter.rejected.add(relayUrl);
        if (waiter.remaining.size === 0) {
          waiter.resolve({ ok: [], rejected: [...waiter.rejected], timedOut: false });
        }
      }
    }
  }

  /**
   * Query relays for specific event IDs (Nostr REQ with `ids` filter).
   * Responses arrive via onReceive; matches our wrapped events by the `e` tag.
   */
  async queryByIds(eventIdsHex: Hex64[]): Promise<void> {
    if (eventIdsHex.length === 0) return;
    const subId = `q${++this.subIdCounter}`;
    const filter = { ids: [] as string[], kinds: [AIRPLANE_NOSTR_KIND], '#e': eventIdsHex };
    // Note: we filter by our event IDs via the `e` tag (Nostr `ids` would
    // match the *envelope* id, which differs per publisher).
    const msg: ClientMsg = ['REQ', subId, filter];
    for (const url of this.relays) this.sendMsg(url, msg);
    // Close the subscription shortly after; relays send EOSE then matching
    // EVENTs. We keep it simple: one-shot query, close after 5s.
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      for (const url of this.relays) this.sendMsg(url, ['CLOSE', subId]);
    }, 5000);
    this.timers.add(timer);
  }

  /** Subscribe to new Airplane events from all open relays. */
  private resubscribe(ws: WebSocketLike): void {
    const subId = `sub${++this.subIdCounter}`;
    const msg: ClientMsg = ['REQ', subId, { kinds: [AIRPLANE_NOSTR_KIND], since: Math.floor(Date.now() / 1000) - 86400 }];
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // will retry on reconnect
    }
  }

  private handleMessage(relayUrl: string, data: string): void {
    if (!this.started) return;
    let msg: unknown[];
    try {
      msg = JSON.parse(data) as unknown[];
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    // Relay acknowledgement for a published envelope: ["OK", id, accepted, message].
    if (msg[0] === 'OK') {
      this.handleOk(relayUrl, msg[1], msg[2]);
      return;
    }
    if (msg[0] !== 'EVENT') return;
    const nostr = msg[2] as NostrEvent | undefined;
    if (!nostr || typeof nostr !== 'object') return;
    const event = unwrapEvent(nostr);
    if (!event) return;
    for (const h of this.receiveHandlers) {
      try {
        h(event, relayUrl);
      } catch {
        // handler errors must not break the transport
      }
    }
  }

  /** Subscribe to unwrapped, signature-verified inbound events. */
  onReceive(cb: (event: SignedEvent, relayUrl: string) => void): () => void {
    this.receiveHandlers.add(cb);
    return () => {
      this.receiveHandlers.delete(cb);
    };
  }
}
