// SPDX-License-Identifier: Apache-2.0
// WsDmRelay tests: custom relay lists and bounded subscribe filters.

import { WsDmRelay } from './dmRelay';
import type { WebSocketLike } from './nostr';

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    if (this.onopen) this.onopen({});
  }
}

describe('WsDmRelay', () => {
  test('subscribe uses the configured relay list, not package defaults', () => {
    const sockets: FakeSocket[] = [];
    const relay = new WsDmRelay({
      relays: ['wss://custom.relay'],
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const unsub = relay.subscribe('aa'.repeat(32), () => {});
    expect(sockets.map((s) => s.url)).toEqual(['wss://custom.relay']);
    unsub();
  });

  test('subscribe filter is bounded by since, not full relay history', () => {
    const sockets: FakeSocket[] = [];
    const relay = new WsDmRelay({
      relays: ['wss://custom.relay'],
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const before = Math.floor(Date.now() / 1000);
    const unsub = relay.subscribe('bb'.repeat(32), () => {});
    sockets[0].open();
    const req = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(req).toBeDefined();
    expect(req[2]['#p']).toEqual(['bb'.repeat(32)]);
    expect(req[2].since as number).toBeGreaterThanOrEqual(before - 86400 - 5);
    expect(req[2].since as number).toBeLessThanOrEqual(before);
    unsub();
  });
});
