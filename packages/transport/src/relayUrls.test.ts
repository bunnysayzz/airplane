// SPDX-License-Identifier: Apache-2.0
// Relay URL validation: scheme, credentials, host, port, private targets,
// and case/port dedupe.

import { normalizeRelayUrl, sanitizeRelayList } from './relayUrls';

describe('normalizeRelayUrl', () => {
  test('accepts a plain wss relay and canonicalizes host case and default port', () => {
    expect(normalizeRelayUrl('wss://Relay.Example.COM:443/')).toBe('wss://relay.example.com');
    expect(normalizeRelayUrl('wss://a.relay:8443')).toBe('wss://a.relay:8443');
  });

  test('rejects non-wss schemes, credentials, and bad ports', () => {
    expect(normalizeRelayUrl('ws://a.relay')).toBeNull();
    expect(normalizeRelayUrl('https://a.relay')).toBeNull();
    expect(normalizeRelayUrl('wss://user:pass@a.relay')).toBeNull();
    expect(normalizeRelayUrl('wss://a.relay:0')).toBeNull();
    expect(normalizeRelayUrl('wss://a.relay:99999')).toBeNull();
    expect(normalizeRelayUrl('wss://a.relay:abc')).toBeNull();
  });

  test('rejects bad hosts', () => {
    expect(normalizeRelayUrl('wss://')).toBeNull();
    expect(normalizeRelayUrl('wss://a b.relay')).toBeNull();
    expect(normalizeRelayUrl('wss://bad_host.relay')).toBeNull();
    expect(normalizeRelayUrl('wss://999.999.999.999')).toBeNull();
  });

  test('drops private targets unless explicitly allowed', () => {
    expect(normalizeRelayUrl('wss://192.168.1.10')).toBeNull();
    expect(normalizeRelayUrl('wss://10.0.0.5:8443')).toBeNull();
    expect(normalizeRelayUrl('wss://localhost')).toBeNull();
    expect(normalizeRelayUrl('wss://192.168.1.10', { allowPrivateRelays: true })).toBe('wss://192.168.1.10');
  });

  test('sanitize dedupes case and port variants', () => {
    expect(
      sanitizeRelayList(['wss://A.relay', 'wss://a.relay:443', 'wss://a.relay/', 'wss://b.relay']),
    ).toEqual(['wss://a.relay', 'wss://b.relay']);
  });
});
