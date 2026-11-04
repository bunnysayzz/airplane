// SPDX-License-Identifier: Apache-2.0
// Tests for the temporary test inbox upload (TESTING ONLY, REMOVE
// AFTER TESTING with logInbox.ts). Every failure path must throw:
// a failed upload must never look like a sent log.

import {
  LOG_INBOX_MAX_BYTES,
  LOG_INBOX_UPLOAD_URL,
  buildLogInboxPayload,
  formatLogInboxSize,
  logTextByteLength,
  parseLogInboxResponse,
  sendDiagnosticsLogToInbox,
} from './logInbox';

const okResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

const fetchReturning = (response: unknown) => jest.fn(async () => response);

describe('buildLogInboxPayload', () => {
  it('carries log text plus version plus timestamp, nothing else', () => {
    const payload = buildLogInboxPayload({
      logText: 'line one\nline two\n',
      version: '0.1.21',
      uploadedAt: '2026-11-04T07:30:00.000Z',
    });
    expect(payload).toEqual({
      log: 'line one\nline two\n',
      version: '0.1.21',
      uploadedAt: '2026-11-04T07:30:00.000Z',
    });
    expect(Object.keys(payload).sort()).toEqual(['log', 'uploadedAt', 'version']);
  });

  it('throws on an empty log', () => {
    expect(() =>
      buildLogInboxPayload({ logText: '', version: '0.1.21', uploadedAt: '2026-11-04T07:30:00.000Z' }),
    ).toThrow('log is empty');
  });

  it('throws on an over-cap log', () => {
    const big = 'x'.repeat(LOG_INBOX_MAX_BYTES + 1);
    expect(() =>
      buildLogInboxPayload({ logText: big, version: '0.1.21', uploadedAt: '2026-11-04T07:30:00.000Z' }),
    ).toThrow('log too large');
  });

  it('accepts a log exactly at the cap', () => {
    const atCap = 'x'.repeat(LOG_INBOX_MAX_BYTES);
    expect(() =>
      buildLogInboxPayload({ logText: atCap, version: '0.1.21', uploadedAt: '2026-11-04T07:30:00.000Z' }),
    ).not.toThrow();
  });
});

describe('formatLogInboxSize', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatLogInboxSize(512)).toBe('512 bytes');
    expect(formatLogInboxSize(1536)).toBe('1.5 KB');
    expect(formatLogInboxSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('measures multi-byte characters as UTF-8 bytes', () => {
    expect(logTextByteLength('aé')).toBe(3);
  });
});

describe('parseLogInboxResponse', () => {
  it('returns the id', () => {
    expect(parseLogInboxResponse({ id: 'abc123' })).toEqual({ id: 'abc123' });
  });

  it('throws when the id is missing or empty', () => {
    expect(() => parseLogInboxResponse({})).toThrow('bad inbox response');
    expect(() => parseLogInboxResponse({ id: '' })).toThrow('bad inbox response');
    expect(() => parseLogInboxResponse(null)).toThrow('bad inbox response');
    expect(() => parseLogInboxResponse('abc123')).toThrow('bad inbox response');
  });
});

describe('sendDiagnosticsLogToInbox', () => {
  const input = {
    logText: 'line one\n',
    version: '0.1.21',
    uploadedAt: '2026-11-04T07:30:00.000Z',
  };

  it('POSTs the payload to the inbox URL and returns the id', async () => {
    const fetchFn = fetchReturning(okResponse({ id: 'k9f2mq7x' }));
    const result = await sendDiagnosticsLogToInbox(input, fetchFn as never);
    expect(result).toEqual({ id: 'k9f2mq7x' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe(LOG_INBOX_UPLOAD_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      log: 'line one\n',
      version: '0.1.21',
      uploadedAt: '2026-11-04T07:30:00.000Z',
    });
  });

  it('throws on a non-200 status and never returns a fake id', async () => {
    const fetchFn = fetchReturning({ ok: false, status: 413, json: async () => ({}) });
    await expect(sendDiagnosticsLogToInbox(input, fetchFn as never)).rejects.toThrow(
      'upload failed: 413',
    );
  });

  it('throws when the network fails', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('network down');
    });
    await expect(sendDiagnosticsLogToInbox(input, fetchFn as never)).rejects.toThrow(
      'network down',
    );
  });

  it('throws on a malformed success response', async () => {
    const fetchFn = fetchReturning(okResponse({}));
    await expect(sendDiagnosticsLogToInbox(input, fetchFn as never)).rejects.toThrow(
      'bad inbox response',
    );
  });
});
