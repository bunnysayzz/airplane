// SPDX-License-Identifier: Apache-2.0
// Transport load balancer: live health model and routing plan.
//
// The ordered router (hybrid.ts) knew only two facts at publish time:
// a network-validated flag and the currently connected BLE peers. It
// checked once, burned one relay deadline, tried mesh once, and then
// the send was done: a relay rejection, a flapping link, or a peer
// arriving a second later never got a second look. The 2026-11-05
// .26 test window showed every failure that follows from that: posts
// relay-OK'd on one relay and never fetched, a BLE handoff lost to
// the notify race with no retry, and a relay rejection with no reason
// and no fallback.
//
// The balancer is the decision layer the router lacked. It keeps a
// live health snapshot per path (relay socket state and rejection
// backoff per relay URL, BLE peer connection and failure backoff per
// peer, network validation state) and, for every send, plans the
// ordered path attempts from that snapshot. It never sends anything
// itself: the app's router executes the plan and reports outcomes
// back, so the health model stays honest. Queued items re-attempt
// whenever health changes (peer connects, relay recovers, network
// validates, backoff expires, app foregrounds); no send is lost
// because the router checked health once at publish time.
//
// Backoff family matches the existing sighting cooldown: 10 s base,
// doubling per consecutive failure, 60 s cap. A path that just failed
// is neither hammered nor trusted blindly; it is re-probed after its
// window. Verification and delivery semantics are unchanged: relay
// first when healthy, DM Delivered only on peer ack, World only on
// relay observation.

/** Base backoff after one path failure, ms. */
export const BALANCER_BACKOFF_BASE_MS = 10_000;
/** Cap for the doubling backoff, ms. */
export const BALANCER_BACKOFF_MAX_MS = 60_000;

/** Next backoff for a path with this many consecutive failures. */
export function nextBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return BALANCER_BACKOFF_BASE_MS;
  const doubled = BALANCER_BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 10);
  return Math.min(doubled, BALANCER_BACKOFF_MAX_MS);
}

/**
 * True when a relay rejection reason means the relay already holds
 * the event. Per NIP-01 an OK false with "duplicate:" is not a
 * judgement against the event: the event is stored on that relay and
 * receivers can fetch it. Treating it as a failure (as v0.1.26 did)
 * misreported delivered posts as rejected and burned DM attempts.
 */
export function isDuplicateRejection(reason: string): boolean {
  return reason.trim().toLowerCase().startsWith('duplicate:');
}

/** Live health of one relay URL. */
export interface RelayHealth {
  url: string;
  socketOpen: boolean;
  lastOkAtMs: number | null;
  lastRejection: { reason: string; atMs: number } | null;
  /** Epoch ms until which this relay is backed off; 0 means not backed off. */
  backoffUntilMs: number;
  /** Consecutive rejection backoffs, for the doubling ladder. */
  consecutiveRejections: number;
}

/** Live health of one BLE peer. */
export interface PeerHealth {
  /** Short tag for logs (first 8 hex), never a full key. */
  tag: string;
  connected: boolean;
  /** Epoch ms until which this peer is not routed to; 0 means healthy. */
  unhealthyUntilMs: number;
  lastFailure: { reason: string; atMs: number } | null;
  /** Consecutive connect failures, for the doubling ladder. */
  consecutiveFailures: number;
}

/** Everything the router needs to plan one send. */
export interface TransportHealth {
  relays: RelayHealth[];
  peers: PeerHealth[];
  /** Null when the network state is unknown (no NetInfo state yet). */
  networkValidated: boolean | null;
  nowMs: number;
}

export type BalancerPath = 'relay' | 'ble';

/** Ordered path attempts for one send, or the queue reason. */
export interface RoutePlan {
  paths: BalancerPath[];
  /** Non-null when paths is empty: why nothing is viable right now. */
  queuedReason: string | null;
  /** One-line plan detail for the diagnostics log. */
  detail: string;
}

export function isRelayBackedOff(relay: RelayHealth, nowMs: number): boolean {
  return relay.backoffUntilMs > nowMs;
}

export function isRelayViable(relay: RelayHealth, nowMs: number): boolean {
  return relay.socketOpen && !isRelayBackedOff(relay, nowMs);
}

export function isPeerHealthy(peer: PeerHealth, nowMs: number): boolean {
  return peer.connected && peer.unhealthyUntilMs <= nowMs;
}

/**
 * Plan one send from live health. Relay first when any relay is
 * viable (internet-first direction stands); BLE whenever a healthy
 * peer is connected; both when both are up, so a relay win still
 * seeds the radio and a relay failure still has the radio to fall
 * back to. Nothing viable means queue with the reason, never a
 * silent drop.
 */
export function planSend(health: TransportHealth): RoutePlan {
  const nowMs = health.nowMs;
  const relayViable =
    health.networkValidated !== false &&
    health.relays.some((r) => isRelayViable(r, nowMs));
  const bleViable = health.peers.some((p) => isPeerHealthy(p, nowMs));
  const relayOpen = health.relays.filter((r) => r.socketOpen).length;
  const blePeers = health.peers.filter((p) => isPeerHealthy(p, nowMs)).length;
  const detail =
    `relay ${relayViable ? `viable (${relayOpen} open)` : 'down'}` +
    `, ble ${bleViable ? `${blePeers} peer(s)` : 'no healthy peers'}` +
    (health.networkValidated === false ? ', network not validated' : '');
  if (relayViable && bleViable) return { paths: ['relay', 'ble'], queuedReason: null, detail };
  if (relayViable) return { paths: ['relay'], queuedReason: null, detail };
  if (bleViable) return { paths: ['ble'], queuedReason: null, detail };
  const reasons: string[] = [];
  if (health.networkValidated === false) reasons.push('network not validated');
  else if (!health.relays.some((r) => r.socketOpen)) reasons.push('no open relay socket');
  else reasons.push('all open relays backed off');
  if (health.peers.length === 0) reasons.push('no BLE peers');
  else reasons.push('no healthy BLE peers');
  return { paths: [], queuedReason: `no live path: ${reasons.join(', ')}`, detail };
}

/**
 * Fold a relay rejection into health. A duplicate is not a failure:
 * the relay holds the event, so no backoff and the stored fact is
 * kept. Any other rejection backs that relay off on the doubling
 * ladder (rate-limited, blocked, invalid). Returns the updated copy;
 * the input is never mutated.
 */
export function applyRelayRejection(
  relay: RelayHealth,
  reason: string,
  nowMs: number,
): RelayHealth {
  if (isDuplicateRejection(reason)) {
    return { ...relay, lastRejection: { reason, atMs: nowMs } };
  }
  const consecutive = relay.consecutiveRejections + 1;
  return {
    ...relay,
    lastRejection: { reason, atMs: nowMs },
    backoffUntilMs: nowMs + nextBackoffMs(consecutive),
    consecutiveRejections: consecutive,
  };
}

/** Fold a relay OK into health: clears backoff, records liveness. */
export function applyRelayOk(relay: RelayHealth, nowMs: number): RelayHealth {
  return {
    ...relay,
    lastOkAtMs: nowMs,
    backoffUntilMs: 0,
    consecutiveRejections: 0,
  };
}

/**
 * Fold a BLE peer connect failure into health. The peer stays
 * connected in name but is not routed to until its backoff window
 * ends, then it is re-probed by the next send or health trigger.
 */
export function applyPeerFailure(
  peer: PeerHealth,
  reason: string,
  nowMs: number,
): PeerHealth {
  const consecutive = peer.consecutiveFailures + 1;
  return {
    ...peer,
    lastFailure: { reason, atMs: nowMs },
    unhealthyUntilMs: nowMs + nextBackoffMs(consecutive),
    consecutiveFailures: consecutive,
  };
}

/** Fold a successful peer connect into health: clears the backoff. */
export function applyPeerConnected(peer: PeerHealth): PeerHealth {
  return { ...peer, connected: true, unhealthyUntilMs: 0, consecutiveFailures: 0 };
}

/**
 * One-line health snapshot for the diagnostics log: counts and
 * reasons only, never content, location, or full keys.
 */
export function healthSummary(health: TransportHealth): string {
  const open = health.relays.filter((r) => r.socketOpen).length;
  const backedOff = health.relays.filter((r) => isRelayBackedOff(r, health.nowMs)).length;
  const peers = health.peers.filter((p) => isPeerHealthy(p, health.nowMs)).length;
  const net =
    health.networkValidated === null
      ? 'unknown'
      : health.networkValidated
        ? 'validated'
        : 'not validated';
  return `relays ${open} open ${backedOff} backed off, ble ${peers} healthy, net ${net}`;
}
