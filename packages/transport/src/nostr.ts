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
  /** Reconnect delay after a drop, ms. Default 5000. */
  reconnectMs?: number;
}

/** Connection state per relay. */
export type RelayState = 'connecting' | 'open' | 'closed';

/**
 * Nostr relay client. Connects to multiple relays, publishes wrapped events,
 * subscribes to Airplane-kind events. No Google services; plain WebSocket.
 *
 * Reconnection: on unexpected close, reconnects after `reconnectMs` while
 * `start()`ed. Call `stop()` to disconnect cleanly.
 */
export class NostrTransport {
  private readonly relays: string[];
  private readonly wsFactory: WebSocketFactory;
  private readonly keys: NostrKeypair;
  private readonly reconnectMs: number;
  private sockets = new Map<string, WebSocketLike>();
  private states = new Map<string, RelayState>();
  private started = false;
  private receiveHandlers = new Set<(event: SignedEvent, relayUrl: string) => void>();
  private subIdCounter = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();

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
      this.states.set(url, 'open');
      this.resubscribe(ws);
    };
    ws.onmessage = (ev) => this.handleMessage(url, ev.data);
    ws.onerror = () => {
      // onclose follows; reconnect there
    };
    ws.onclose = () => {
      this.sockets.delete(url);
      this.states.set(url, 'closed');
      this.scheduleReconnect(url);
    };
  }

  private scheduleReconnect(url: string): void {
    if (!this.started) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.connectOne(url);
    }, this.reconnectMs);
    this.timers.add(timer);
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

  /** Publish one event to all open relays. Returns URLs that accepted it. */
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
    let msg: unknown[];
    try {
      msg = JSON.parse(data) as unknown[];
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT') return;
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
