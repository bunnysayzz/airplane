// SPDX-License-Identifier: Apache-2.0
// Tests for the pure-JS Sentry envelope client (src/sentry.ts). The client
// must never throw, must stay silent without a DSN, must tag the publish
// stage, and must never include post text, location, pubkeys, or secrets.

import {
  initSentry,
  captureError,
  addBreadcrumb,
  parseDsn,
  isSentryEnabled,
  takeSentryDisabledNote,
  __getBreadcrumbsForTests,
} from '../../src/sentry';

const TEST_DSN = 'https://publickey123@o0.ingest.sentry.io/123';

const fetchMock = jest.fn();

beforeEach(() => {
  delete process.env['EXPO_PUBLIC_SENTRY_DSN'];
  fetchMock.mockReset().mockResolvedValue({});
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  initSentry();
});

afterEach(() => {
  delete process.env['EXPO_PUBLIC_SENTRY_DSN'];
  jest.restoreAllMocks();
});

/** The fetch body is a 3-line Sentry envelope; the event is line 3. */
function sentEvent(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = fetchMock.mock.calls[0][1].body as string;
  const lines = body.split('\n');
  expect(lines).toHaveLength(3);
  return JSON.parse(lines[2]) as Record<string, unknown>;
}

function exceptionValues(
  event: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const exception = event['exception'] as {
    values: Array<Record<string, unknown>>;
  };
  return exception.values;
}

function breadcrumbValues(
  event: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const breadcrumbs = event['breadcrumbs'] as {
    values: Array<Record<string, unknown>>;
  };
  return breadcrumbs.values;
}

function collectKeys(obj: unknown, out = new Set<string>()): Set<string> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('parseDsn', () => {
  test('parses a sentry.io DSN', () => {
    expect(parseDsn(TEST_DSN)).toEqual({
      protocol: 'https',
      publicKey: 'publickey123',
      host: 'o0.ingest.sentry.io',
      pathPrefix: '',
      projectId: '123',
    });
  });

  test('parses a self-hosted DSN with a path prefix', () => {
    expect(parseDsn('https://key@example.com/sentry/42')).toEqual({
      protocol: 'https',
      publicKey: 'key',
      host: 'example.com',
      pathPrefix: 'sentry',
      projectId: '42',
    });
  });

  test('rejects malformed DSNs', () => {
    expect(parseDsn('')).toBeNull();
    expect(parseDsn('not-a-dsn')).toBeNull();
    expect(parseDsn('https://key@host/abc')).toBeNull();
    expect(parseDsn('https://key@host/')).toBeNull();
  });
});

describe('captureError', () => {
  test('stays silent without a DSN', () => {
    captureError(new Error('boom'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('stays silent with a malformed DSN', () => {
    initSentry('garbage');
    captureError(new Error('boom'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends an envelope to the DSN project with the stage tag', () => {
    initSentry(TEST_DSN);
    const err = Object.assign(new Error('disk full'), { stage: 'save' });
    captureError(err);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/123/envelope/');
    expect(url).toContain('sentry_key=publickey123');
    const event = sentEvent();
    expect(event['level']).toBe('error');
    expect(event['tags']).toEqual({ publish_stage: 'save' });
    const values = exceptionValues(event);
    expect(values[0]['type']).toBe('Error');
    expect(values[0]['value']).toBe('disk full');
  });

  test('never includes post text, location, pubkeys, or secrets in the payload', () => {
    initSentry(TEST_DSN);
    addBreadcrumb('keystore-fallback', { reason: 'Error' });
    captureError(new Error('boom'));
    const event = sentEvent();
    const keys = collectKeys(event);
    for (const forbidden of [
      'content',
      'geohash',
      'pubkey',
      'secretKey',
      'secret',
      'location',
      'latitude',
      'longitude',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(event)).not.toContain('publickey123');
  });

  test('scrubs a 64-char hex string and a coordinate pair from the event', () => {
    initSentry(TEST_DSN);
    const fullId = 'cd'.repeat(32);
    addBreadcrumb('keystore-fallback', { reason: 'ok', leaked: fullId });
    captureError(new Error(`publish failed for ${fullId} at 12.345678, 77.123456`));
    const event = sentEvent();
    const body = JSON.stringify(event);
    expect(body).not.toContain(fullId);
    expect(body).not.toContain('12.345678, 77.123456');
    const crumbs = breadcrumbValues(event);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]['data']).toEqual({ reason: 'ok' });
  });

  test('attaches breadcrumbs to the event', () => {
    initSentry(TEST_DSN);
    addBreadcrumb('keystore-fallback', { reason: 'Error' });
    captureError(new Error('boom'));
    const event = sentEvent();
    const crumbs = breadcrumbValues(event);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]['message']).toBe('keystore-fallback');
  });

  test('disabled note is consumable once per disabled stretch', () => {
    expect(isSentryEnabled()).toBe(false);
    expect(takeSentryDisabledNote()).toBe(true);
    expect(takeSentryDisabledNote()).toBe(false);
    initSentry(TEST_DSN);
    expect(isSentryEnabled()).toBe(true);
    expect(takeSentryDisabledNote()).toBe(false);
    initSentry('garbage');
    expect(isSentryEnabled()).toBe(false);
    expect(takeSentryDisabledNote()).toBe(true);
  });

  test('never throws, even when fetch rejects', async () => {
    initSentry(TEST_DSN);
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(() => captureError(new Error('boom'))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('addBreadcrumb', () => {
  test('caps the buffer at 20, dropping the oldest', () => {
    for (let i = 0; i < 25; i++) {
      addBreadcrumb(`crumb-${i}`);
    }
    const crumbs = __getBreadcrumbsForTests();
    expect(crumbs).toHaveLength(20);
    expect(crumbs[0]?.message).toBe('crumb-5');
    expect(crumbs[19]?.message).toBe('crumb-24');
  });
});
