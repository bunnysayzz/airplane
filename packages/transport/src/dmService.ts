// SPDX-License-Identifier: Apache-2.0
// DM P1 service: conversations, requests folder, block/mute, delete-local-only,
// persistent-shaped outbox with backoff + per-conversation FIFO.
//
// SEPARATE DM STORE (plan §8): nothing here touches the public post store.
// Messages are stored SEALED; thread views decrypt on read only and never
// persist plaintext. Deleting a conversation removes its rows from this store
// only — relay envelopes and the recipient's copy are untouched (local only).
// Read receipts: none sent, none requested (orders).
// Delivery states: Sending / Sent / Failed only (orders).

import { x25519 } from '@noble/curves/ed25519.js';
import {
  DM_BACKOFF_MS,
  DM_MAX_ATTEMPTS,
  DM_TEXT_MAX_BYTES,
  DM_UNDECRYPTABLE_PLACEHOLDER,
  dmToHex,
  isHex64,
  sealDm,
  unsealDm,
  type DmEnvelope,
  type DmKeypair,
  type DmRumor,
} from './dm';

// Re-export the placeholder for UI layers.
export { DM_UNDECRYPTABLE_PLACEHOLDER };

export type DmDelivery = 'Sending' | 'Sent' | 'Failed';
export type DmConversationState = 'inbox' | 'request' | 'blocked';

export interface DmMessageRow {
  id: string;
  peerHex: string;
  direction: 'out' | 'in';
  /** Sealed NIP-44-style payload (outgoing: sealed to the peer; incoming: as received). */
  sealed: string;
  /**
   * Full sendable envelope (ephemeral pubkey header + sealed payload).
   * R5: persisted by the SQLite store next to `sealed`, so an outbox retry
   * after a restart can re-send the identical bytes instead of going
   * Failed for a missing in-memory envelope. Never contains plaintext.
   */
  envelope?: DmEnvelope;
  createdAtMs: number;
  status: DmDelivery;
  attempts: number;
  nextAttemptAtMs: number;
}

export interface DmConversationRow {
  peerHex: string;
  state: DmConversationState;
  muted: boolean;
  /** A request the user chose Ignore on: hidden until that peer writes again. */
  ignored: boolean;
  unread: number;
  lastMessageAtMs: number;
  lastSealed: string | null;
  lastDirection: 'out' | 'in' | null;
}

/** Decrypted-on-read thread row. `text === null` renders the placeholder. */
export interface DmThreadRow {
  id: string;
  direction: 'out' | 'in';
  text: string | null;
  status: DmDelivery;
  createdAtMs: number;
}

/** The store port. MemoryDmStore is the in-process implementation; a SQLite
 *  implementation must use SEPARATE dm_* tables, never the post tables. */
export interface DmStorePort {
  upsertConversation(c: DmConversationRow): Promise<void>;
  getConversation(peerHex: string): Promise<DmConversationRow | null>;
  listConversations(): Promise<DmConversationRow[]>;
  deleteConversation(peerHex: string): Promise<void>;
  addMessage(m: DmMessageRow): Promise<void>;
  updateMessage(m: DmMessageRow): Promise<void>;
  listMessages(peerHex: string): Promise<DmMessageRow[]>;
  deleteMessages(peerHex: string): Promise<void>;
}

export class MemoryDmStore implements DmStorePort {
  private readonly conversations = new Map<string, DmConversationRow>();
  private readonly messages = new Map<string, DmMessageRow[]>();

  async upsertConversation(c: DmConversationRow): Promise<void> {
    this.conversations.set(c.peerHex, { ...c });
  }

  async getConversation(peerHex: string): Promise<DmConversationRow | null> {
    const c = this.conversations.get(peerHex);
    return c ? { ...c } : null;
  }

  async listConversations(): Promise<DmConversationRow[]> {
    return [...this.conversations.values()].map(c => ({ ...c }));
  }

  async deleteConversation(peerHex: string): Promise<void> {
    this.conversations.delete(peerHex);
    this.messages.delete(peerHex);
  }

  async addMessage(m: DmMessageRow): Promise<void> {
    const list = this.messages.get(m.peerHex) ?? [];
    list.push({ ...m });
    this.messages.set(m.peerHex, list);
  }

  async updateMessage(m: DmMessageRow): Promise<void> {
    const list = this.messages.get(m.peerHex) ?? [];
    const idx = list.findIndex(x => x.id === m.id);
    if (idx >= 0) list[idx] = { ...m };
    else list.push({ ...m });
  }

  async listMessages(peerHex: string): Promise<DmMessageRow[]> {
    return (this.messages.get(peerHex) ?? []).map(m => ({ ...m }));
  }

  async deleteMessages(peerHex: string): Promise<void> {
    this.messages.delete(peerHex);
  }
}

/** Relay seam. publish() resolves true only when a relay accepted the envelope. */
export interface DmRelayPort {
  publish(envelope: DmEnvelope): Promise<boolean>;
  subscribe(ownMeshHex: string, onEnvelope: (e: DmEnvelope) => void): () => void;
}

/** In-process relay for tests/dev: delivers to every registered subscriber
 *  whose address matches the envelope recipient. Never inspects content. */
export class MemoryDmRelay implements DmRelayPort {
  private readonly subs = new Set<{ ownHex: string; cb: (e: DmEnvelope) => void }>();

  async publish(envelope: DmEnvelope): Promise<boolean> {
    for (const s of [...this.subs]) {
      if (s.ownHex === envelope.recipientHex) s.cb(envelope);
    }
    return true;
  }

  subscribe(ownMeshHex: string, onEnvelope: (e: DmEnvelope) => void): () => void {
    const entry = { ownHex: ownMeshHex, cb: onEnvelope };
    this.subs.add(entry);
    return () => {
      this.subs.delete(entry);
    };
  }
}

/** Relay that always refuses (offline / relay down): outbox must queue, never drop. */
export class FailingDmRelay implements DmRelayPort {
  async publish(): Promise<boolean> {
    return false;
  }

  subscribe(): () => void {
    return () => {};
  }
}

export interface DmServiceOpts {
  store: DmStorePort;
  relay: DmRelayPort;
  /** This device's DM keypair (derived from the device Ed25519 secret). */
  ownKeys: () => DmKeypair;
  /** This device's mesh pubkey hex (the DM address others write to). */
  ownMeshHex: () => string;
  now?: () => number;
}

function newId(): string {
  return dmToHex(x25519.utils.randomSecretKey().slice(0, 16));
}

export class DmService {
  private readonly store: DmStorePort;
  private readonly relay: DmRelayPort;
  private readonly ownKeys: () => DmKeypair;
  private readonly ownMeshHex: () => string;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private unsub: (() => void) | null = null;

  constructor(opts: DmServiceOpts) {
    this.store = opts.store;
    this.relay = opts.relay;
    this.ownKeys = opts.ownKeys;
    this.ownMeshHex = opts.ownMeshHex;
    this.now = opts.now ?? (() => Date.now());
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  /** Start listening for incoming sealed envelopes addressed to this device. */
  start(): void {
    if (this.unsub) return;
    this.unsub = this.relay.subscribe(this.ownMeshHex(), envelope => {
      void this.receiveEnvelope(envelope);
    });
  }

  stop(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  /** Open (or create) a conversation with a peer. Own-initiated = inbox, never requests. */
  async startConversation(peerHex: string): Promise<DmConversationRow> {
    if (!isHex64(peerHex)) throw new Error('startConversation: peer pubkey must be 64 lowercase hex chars');
    if (peerHex === this.ownMeshHex()) throw new Error('startConversation: cannot DM yourself');
    const existing = await this.store.getConversation(peerHex);
    if (existing) return existing;
    const row: DmConversationRow = {
      peerHex,
      state: 'inbox',
      muted: false,
      ignored: false,
      unread: 0,
      lastMessageAtMs: 0,
      lastSealed: null,
      lastDirection: null,
    };
    await this.store.upsertConversation(row);
    this.emit();
    return row;
  }

  /** Queue an outgoing text DM. Returns the stored (sealed) row. */
  async sendMessage(peerHex: string, text: string): Promise<DmMessageRow> {
    if (new TextEncoder().encode(text).length > DM_TEXT_MAX_BYTES) {
      throw new Error(`sendMessage: DM longer than ${DM_TEXT_MAX_BYTES} bytes`);
    }
    if (text.length === 0) throw new Error('sendMessage: empty DM');
    const conv = await this.startConversation(peerHex);
    if (conv.state === 'blocked') throw new Error('sendMessage: peer is blocked');
    const nowMs = this.now();
    const envelope = sealDm(text, this.ownMeshHex(), peerHex, Math.floor(nowMs / 1000));
    const row: DmMessageRow = {
      id: newId(),
      peerHex,
      direction: 'out',
      sealed: envelope.sealed,
      envelope,
      createdAtMs: nowMs,
      status: 'Sending',
      attempts: 0,
      nextAttemptAtMs: nowMs,
    };
    // The row's `sealed` is sealed to the PEER, so the sender's own thread
    // view cannot decrypt it back: the plaintext lives only in the
    // memory-only cache below (never on disk), and the full envelope (with
    // its ephemeral pubkey, which the row does not carry) lives in the
    // memory-only outbox map so retries can re-send the identical bytes.
    this.outboxEnvelopes.set(row.id, envelope);
    this.outgoingPlaintext.set(row.id, text);
    await this.store.addMessage(row);
    await this.touchConversation(peerHex, row);
    this.emit();
    return row;
  }

  /**
   * Flush the outbox. R5: NO head-of-line blocking. Messages go in
   * created order within a conversation, but a failed message no longer
   * stops the rest of that conversation's queue (plan section 7.5): the
   * failed row keeps its own backoff and the next due message is still
   * attempted. Other conversations were never blocked. Never silently
   * drops: a message that exhausts DM_MAX_ATTEMPTS becomes Failed.
   */
  async flushOutbox(nowMs?: number): Promise<void> {
    const now = nowMs ?? this.now();
    const convs = await this.store.listConversations();
    let changed = false;
    for (const conv of convs) {
      if (conv.state === 'blocked') continue;
      const messages = (await this.store.listMessages(conv.peerHex)).sort(
        (a, b) => a.createdAtMs - b.createdAtMs,
      );
      for (const m of messages) {
        if (m.direction !== 'out' || m.status !== 'Sending') continue;
        if (m.nextAttemptAtMs > now) continue;
        await this.tryPublish(m, now);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private async tryPublish(m: DmMessageRow, now: number): Promise<boolean> {
    // R5: the sendable envelope lives on the row itself (persisted by the
    // SQLite store), with the memory-only outbox map as a fast path. A
    // restart no longer strands an unsent row: only a row that somehow has
    // no envelope at all goes Failed, visibly, never silently dropped.
    const envelope = this.outboxEnvelopes.get(m.id) ?? m.envelope;
    if (!envelope) {
      m.status = 'Failed';
      await this.store.updateMessage(m);
      return false;
    }
    let accepted = false;
    try {
      accepted = await this.relay.publish(envelope);
    } catch {
      accepted = false;
    }
    if (accepted) {
      m.status = 'Sent';
      await this.store.updateMessage(m);
      return true;
    }
    m.attempts += 1;
    if (m.attempts >= DM_MAX_ATTEMPTS) {
      m.status = 'Failed';
    } else {
      m.nextAttemptAtMs = now + DM_BACKOFF_MS[Math.min(m.attempts, DM_BACKOFF_MS.length - 1)];
    }
    await this.store.updateMessage(m);
    return false;
  }

  /** In-memory outbox envelopes, keyed by message id (see tryPublish note). */
  private readonly outboxEnvelopes = new Map<string, DmEnvelope>();

  /** Tap-to-retry a Failed message: back to Sending, attempts reset, due now. */
  async retryMessage(peerHex: string, messageId: string): Promise<void> {
    const messages = await this.store.listMessages(peerHex);
    const m = messages.find(x => x.id === messageId);
    if (!m || m.direction !== 'out' || m.status !== 'Failed') return;
    m.status = 'Sending';
    m.attempts = 0;
    m.nextAttemptAtMs = this.now();
    await this.store.updateMessage(m);
    this.emit();
  }

  /** Route one incoming sealed envelope. Returns what happened (for tests/logs). */
  async receiveEnvelope(envelope: DmEnvelope): Promise<'inbox' | 'request' | 'dropped' | 'ignored'> {
    if (envelope.recipientHex !== this.ownMeshHex()) return 'ignored';
    const rumor = unsealDm(envelope, this.ownKeys());
    if (!rumor) return 'ignored'; // not for us / corrupt: never surface, never crash
    const senderHex = rumor.pubkey;
    if (senderHex === this.ownMeshHex()) return 'ignored';
    const existing = await this.store.getConversation(senderHex);
    if (existing?.state === 'blocked') return 'dropped'; // silent drop: no row, no badge
    const nowMs = this.now();
    const row: DmMessageRow = {
      id: newId(),
      peerHex: senderHex,
      direction: 'in',
      sealed: envelope.sealed,
      envelope,
      createdAtMs: nowMs,
      status: 'Sent', // inbound: already delivered to this device
      attempts: 0,
      nextAttemptAtMs: nowMs,
    };
    await this.store.addMessage(row);
    this.incomingEnvelopes.set(row.id, envelope);
    if (!existing) {
      // Unknown sender -> requests folder, NEVER straight to inbox (orders).
      await this.store.upsertConversation({
        peerHex: senderHex,
        state: 'request',
        muted: false,
        ignored: false,
        unread: 1,
        lastMessageAtMs: nowMs,
        lastSealed: envelope.sealed,
        lastDirection: 'in',
      });
      this.emit();
      return 'request';
    }
    const next: DmConversationRow = {
      ...existing,
      ignored: false, // a new message re-surfaces an Ignored request (plan §6)
      lastMessageAtMs: nowMs,
      lastSealed: envelope.sealed,
      lastDirection: 'in',
    };
    // Mute = messages arrive but the badge does not move (plan §6).
    if (!existing.muted) next.unread = existing.unread + 1;
    await this.store.upsertConversation(next);
    this.emit();
    return existing.state === 'request' ? 'request' : 'inbox';
  }

  async acceptRequest(peerHex: string): Promise<void> {
    const c = await this.store.getConversation(peerHex);
    if (c && c.state === 'request') {
      await this.store.upsertConversation({ ...c, state: 'inbox', ignored: false });
      this.emit();
    }
  }

  async ignoreRequest(peerHex: string): Promise<void> {
    const c = await this.store.getConversation(peerHex);
    if (c && c.state === 'request') {
      await this.store.upsertConversation({ ...c, ignored: true });
      this.emit();
    }
  }

  async blockPeer(peerHex: string): Promise<void> {
    const c = await this.store.getConversation(peerHex);
    if (c) {
      await this.store.upsertConversation({ ...c, state: 'blocked', ignored: false, unread: 0 });
    } else {
      await this.store.upsertConversation({
        peerHex,
        state: 'blocked',
        muted: false,
        ignored: false,
        unread: 0,
        lastMessageAtMs: 0,
        lastSealed: null,
        lastDirection: null,
      });
    }
    this.emit();
  }

  async unblockPeer(peerHex: string): Promise<void> {
    const c = await this.store.getConversation(peerHex);
    if (c && c.state === 'blocked') {
      if (c.lastMessageAtMs === 0) {
        // Blocked before any message ever arrived: no history to keep, so
        // drop the row — the peer's next message then routes as unknown
        // (requests folder), exactly as if never blocked.
        await this.store.deleteConversation(peerHex);
      } else {
        await this.store.upsertConversation({ ...c, state: 'inbox' });
      }
      this.emit();
    }
  }

  async mutePeer(peerHex: string, muted: boolean): Promise<void> {
    const c = await this.store.getConversation(peerHex);
    if (c) {
      await this.store.upsertConversation({ ...c, muted });
      this.emit();
    }
  }

  /**
   * Delete LOCAL ONLY: removes the conversation + all its messages from this
   * device's DM store. Relay envelopes and the recipient's copy are untouched
   * — unsend is impossible, and the UI must say so.
   */
  async deleteConversationLocalOnly(peerHex: string): Promise<void> {
    const messages = await this.store.listMessages(peerHex);
    for (const m of messages) {
      this.outboxEnvelopes.delete(m.id);
      this.outgoingPlaintext.delete(m.id);
      this.incomingEnvelopes.delete(m.id);
    }
    await this.store.deleteConversation(peerHex);
    this.emit();
  }

  async markRead(peerHex: string): Promise<void> {
    const c = await this.store.getConversation(peerHex);
    if (c && c.unread !== 0) {
      await this.store.upsertConversation({ ...c, unread: 0 });
      this.emit();
    }
  }

  async listInbox(): Promise<DmConversationRow[]> {
    const all = await this.store.listConversations();
    return all
      .filter(c => c.state === 'inbox')
      .sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs);
  }

  async listRequests(): Promise<DmConversationRow[]> {
    const all = await this.store.listConversations();
    return all
      .filter(c => c.state === 'request' && !c.ignored)
      .sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs);
  }

  async listBlocked(): Promise<DmConversationRow[]> {
    const all = await this.store.listConversations();
    return all.filter(c => c.state === 'blocked').sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs);
  }

  /** Total unread badge: inbox conversations only, muted excluded, requests excluded. */
  async totalUnread(): Promise<number> {
    const inbox = await this.listInbox();
    return inbox.filter(c => !c.muted).reduce((n, c) => n + c.unread, 0);
  }

  async requestCount(): Promise<number> {
    return (await this.listRequests()).length;
  }

  /** Thread view: decrypt on read only. Outgoing rows were sealed to the peer,
   *  so they cannot be decrypted by self — their text comes from the send-time
   *  plaintext cache (memory only, never disk). Unknown rows get null text
   *  (the UI renders the "Encrypted message" placeholder). */
  async getThread(peerHex: string): Promise<DmThreadRow[]> {
    const rows = (await this.store.listMessages(peerHex)).sort((a, b) => a.createdAtMs - b.createdAtMs);
    return rows.map(m => this.decryptRow(m));
  }

  private decryptRow(m: DmMessageRow): DmThreadRow {
    if (m.direction === 'out') {
      return {
        id: m.id,
        direction: 'out' as const,
        text: this.outgoingPlaintext.get(m.id) ?? null,
        status: m.status,
        createdAtMs: m.createdAtMs,
      };
    }
    return {
      id: m.id,
      direction: 'in' as const,
      text: this.decryptIncoming(m),
      status: m.status,
      createdAtMs: m.createdAtMs,
    };
  }

  /** Last-message preview for a conversation row: decrypted text, or null
   *  when the last message is undecryptable (UI shows the placeholder). */
  async previewFor(peerHex: string): Promise<string | null> {
    const rows = (await this.store.listMessages(peerHex)).sort((a, b) => a.createdAtMs - b.createdAtMs);
    const last = rows[rows.length - 1];
    if (!last) return null;
    return this.decryptRow(last).text;
  }

  /** Memory-only plaintext for outgoing rows (never persisted). */
  private readonly outgoingPlaintext = new Map<string, string>();

  private decryptIncoming(m: DmMessageRow): string | null {
    // R5: the envelope is on the row itself (persisted), so incoming text
    // survives a restart; the memory-only map is a fast path for pre-R5 rows.
    const envelope = m.envelope ?? this.incomingEnvelopes.get(m.id);
    if (!envelope) return null;
    const rumor: DmRumor | null = unsealDm(envelope, this.ownKeys());
    return rumor ? rumor.content : null;
  }

  private readonly incomingEnvelopes = new Map<string, DmEnvelope>();

  private async touchConversation(peerHex: string, m: DmMessageRow): Promise<void> {
    const c = await this.store.getConversation(peerHex);
    if (!c) return;
    await this.store.upsertConversation({
      ...c,
      lastMessageAtMs: m.createdAtMs,
      lastSealed: m.sealed,
      lastDirection: m.direction,
    });
  }
}

// R5 NOTE (what still lives in memory only): the outgoing plaintext cache
// (own-thread text) is deliberately never written to disk — sealed-at-rest
// means the store holds sealed bytes only, so after a restart an own sent
// message shows the "Encrypted message" placeholder until it is re-read
// from a fresh send. That is a privacy trade, not a data loss: the sealed
// row, its envelope, and its status all survive. Incoming messages are
// unaffected: their envelopes are on the row, so they decrypt on read
// after a restart too. The SQLite implementation is
// apps/mobile/services/airplane/dmSqlite.ts (separate dm_* tables).
