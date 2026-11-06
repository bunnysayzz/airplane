// SPDX-License-Identifier: Apache-2.0
import {
  applyPeerConnected,
  applyPeerFailure,
  applyRelayOk,
  applyRelayRejection,
  healthSummary,
  isDuplicateRejection,
  nextBackoffMs,
  planSend,
} from './balancer';
import type { PeerHealth, RelayHealth, TransportHealth } from './balancer';

function relay(partial: Partial<RelayHealth> = {}): RelayHealth {
  return {
    url: 'wss://relay.example',
    socketOpen: true,
    lastOkAtMs: null,
    lastRejection: null,
    backoffUntilMs: 0,
    consecutiveRejections: 0,
    ...partial,
  };
}

function peer(partial: Partial<PeerHealth> = {}): PeerHealth {
  return {
    tag: 'aabbccdd',
    connected: true,
    unhealthyUntilMs: 0,
    lastFailure: null,
    consecutiveFailures: 0,
    ...partial,
  };
}

function health(partial: Partial<TransportHealth> = {}): TransportHealth {
  return { relays: [relay()], peers: [peer()], networkValidated: true, nowMs: 1000, ...partial };
}

describe('balancer backoff ladder', () => {
  test('doubles from 10s and caps at 60s', () => {
    expect(nextBackoffMs(1)).toBe(10_000);
    expect(nextBackoffMs(2)).toBe(20_000);
    expect(nextBackoffMs(3)).toBe(40_000);
    expect(nextBackoffMs(4)).toBe(60_000);
    expect(nextBackoffMs(10)).toBe(60_000);
  });
});

describe('duplicate rejection', () => {
  test('duplicate prefix counts as already stored', () => {
    expect(isDuplicateRejection('duplicate: already have it')).toBe(true);
    expect(isDuplicateRejection('Duplicate: x')).toBe(true);
    expect(isDuplicateRejection('rate-limited: slow down')).toBe(false);
    expect(isDuplicateRejection('blocked: policy')).toBe(false);
  });

  test('a duplicate rejection backs nothing off', () => {
    const after = applyRelayRejection(relay(), 'duplicate: event exists', 1000);
    expect(after.backoffUntilMs).toBe(0);
    expect(after.consecutiveRejections).toBe(0);
    expect(after.lastRejection?.reason).toBe('duplicate: event exists');
  });

  test('a rate-limit rejection backs the relay off on the ladder', () => {
    const first = applyRelayRejection(relay(), 'rate-limited: too fast', 1000);
    expect(first.backoffUntilMs).toBe(11_000);
    const second = applyRelayRejection(first, 'rate-limited: too fast', 12_000);
    expect(second.backoffUntilMs).toBe(32_000);
  });

  test('a relay OK clears backoff', () => {
    const backed = applyRelayRejection(relay(), 'blocked: policy', 1000);
    expect(backed.backoffUntilMs).toBeGreaterThan(1000);
    const ok = applyRelayOk(backed, 5000);
    expect(ok.backoffUntilMs).toBe(0);
    expect(ok.consecutiveRejections).toBe(0);
    expect(ok.lastOkAtMs).toBe(5000);
  });
});

describe('planSend situation matrix', () => {
  test('both up: relay first, then ble', () => {
    const plan = planSend(health());
    expect(plan.paths).toEqual(['relay', 'ble']);
    expect(plan.queuedReason).toBeNull();
  });

  test('internet only: relay only', () => {
    const plan = planSend(health({ peers: [] }));
    expect(plan.paths).toEqual(['relay']);
  });

  test('BLE only: ble only', () => {
    const plan = planSend(health({ relays: [relay({ socketOpen: false })], networkValidated: true }));
    expect(plan.paths).toEqual(['ble']);
  });

  test('neither: queued with the reason, never a silent drop', () => {
    const plan = planSend(health({ relays: [relay({ socketOpen: false })], peers: [] }));
    expect(plan.paths).toEqual([]);
    expect(plan.queuedReason).toContain('no live path');
    expect(plan.queuedReason).toContain('no open relay socket');
    expect(plan.queuedReason).toContain('no BLE peers');
  });

  test('network not validated: relay is not viable even with an open socket', () => {
    const plan = planSend(health({ networkValidated: false }));
    expect(plan.paths).toEqual(['ble']);
  });

  test('unknown network: relay stays viable on the live socket fact', () => {
    const plan = planSend(health({ networkValidated: null }));
    expect(plan.paths).toEqual(['relay', 'ble']);
  });

  test('all open relays backed off: relay is not viable', () => {
    const backed = applyRelayRejection(relay(), 'rate-limited: slow', 1000);
    const plan = planSend(health({ relays: [backed], nowMs: 5000 }));
    expect(plan.paths).toEqual(['ble']);
  });

  test('backoff expiry re-probes the relay', () => {
    const backed = applyRelayRejection(relay(), 'rate-limited: slow', 1000);
    const plan = planSend(health({ relays: [backed], nowMs: 11_001 }));
    expect(plan.paths).toEqual(['relay', 'ble']);
  });

  test('a flapping peer is not routed to until its window ends', () => {
    const failed = applyPeerFailure(peer(), 'connectGatt returned null', 1000);
    const plan = planSend(health({ relays: [relay({ socketOpen: false })], peers: [failed], nowMs: 5000 }));
    expect(plan.paths).toEqual([]);
    const later = planSend(health({ relays: [relay({ socketOpen: false })], peers: [failed], nowMs: 11_001 }));
    expect(later.paths).toEqual(['ble']);
  });

  test('a peer connect clears the backoff', () => {
    const failed = applyPeerFailure(peer(), 'device disconnected', 1000);
    const ok = applyPeerConnected(failed);
    expect(ok.unhealthyUntilMs).toBe(0);
    expect(ok.consecutiveFailures).toBe(0);
    const plan = planSend(health({ relays: [relay({ socketOpen: false })], peers: [ok], nowMs: 2000 }));
    expect(plan.paths).toEqual(['ble']);
  });

  test('peer failure backoff doubles across consecutive failures', () => {
    const first = applyPeerFailure(peer(), 'timeout', 1000);
    expect(first.unhealthyUntilMs).toBe(11_000);
    const second = applyPeerFailure({ ...first, connected: true }, 'timeout', 12_000);
    expect(second.unhealthyUntilMs).toBe(32_000);
  });

  test('health summary carries counts and reasons only', () => {
    const summary = healthSummary(health());
    expect(summary).toContain('relays 1 open 0 backed off');
    expect(summary).toContain('ble 1 healthy');
    expect(summary).toContain('net validated');
  });
});

describe('v0.1.31 DM pool visibility + per-peer heterogeneous routing', () => {
  test('health summary carries the DM pool open count when present, and is unchanged when absent', () => {
    const withDm = healthSummary(health({ dmRelays: [relay({ url: 'wss://dm.relay' })] }));
    expect(withDm).toContain('relays 1 open 0 backed off, dm relays 1 open');
    expect(withDm).toContain('ble 1 healthy');
    const withoutDm = healthSummary(health());
    expect(withoutDm).toBe('relays 1 open 0 backed off, ble 1 healthy, net validated');
    const dmDown = healthSummary(health({ dmRelays: [relay({ url: 'wss://dm.relay', socketOpen: false })] }));
    expect(dmDown).toContain('dm relays 0 open');
  });

  test('one healthy peer keeps the BLE leg viable while its sibling is backed off', () => {
    const flapping = applyPeerFailure(peer({ tag: 'aaaaaaaa' }), 'timeout', 1000);
    const steady = peer({ tag: 'bbbbbbbb' });
    const plan = planSend(
      health({
        relays: [relay({ socketOpen: false })],
        peers: [flapping, steady],
        nowMs: 5000,
      }),
    );
    expect(plan.paths).toEqual(['ble']);
    expect(plan.queuedReason).toBeNull();
  });

  test('all peers backed off queues the post, with the reason naming the flapping peer', () => {
    const flapping = applyPeerFailure(peer({ tag: 'aaaaaaaa' }), 'timeout', 1000);
    const alsoFlapping = applyPeerFailure(peer({ tag: 'bbbbbbbb' }), 'timeout', 1000);
    const plan = planSend(
      health({
        relays: [relay({ socketOpen: false })],
        peers: [flapping, alsoFlapping],
        nowMs: 5000,
      }),
    );
    expect(plan.paths).toEqual([]);
    expect(plan.queuedReason).toContain('no live path');
    expect(plan.queuedReason).toContain('no healthy BLE peers');
  });

  test('a backed-off peer recovers on its own window while the healthy peer never stops routing', () => {
    const flapping = applyPeerFailure(peer({ tag: 'aaaaaaaa' }), 'timeout', 1000);
    const steady = peer({ tag: 'bbbbbbbb' });
    const during = planSend(
      health({ relays: [relay({ socketOpen: false })], peers: [flapping, steady], nowMs: 5000 }),
    );
    expect(during.paths).toEqual(['ble']);
    const after = planSend(
      health({ relays: [relay({ socketOpen: false })], peers: [flapping, steady], nowMs: 11_001 }),
    );
    expect(after.paths).toEqual(['ble']);
  });
});
