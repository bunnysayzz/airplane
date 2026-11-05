// SPDX-License-Identifier: Apache-2.0
// Tests for the temporary test inbox upload (TESTING ONLY, REMOVE
// AFTER TESTING with logInbox.ts). Every failure path must throw:
// a failed upload must never look like a sent log.

import { MemoryKv } from '@airplane/storage';
import {
  LOG_INBOX_MAX_BYTES,
  LOG_INBOX_UPLOAD_URL,
  buildLogInboxPayload,
  countLogLines,
  formatLogInboxSize,
  initializeLogInboxWatermarkIfNeeded,
  logTextByteLength,
  parseLogInboxResponse,
  parseLogInboxWatermark,
  planLogInboxUpload,
  readLogInboxWatermark,
  sendDiagnosticsLogToInbox,
  sliceLogTextFromByteOffset,
  writeLogInboxWatermark,
  type LogInboxWatermark,
} from './logInbox';

const okResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

const fetchReturning = (response: unknown) => jest.fn(async () => response);

describe('buildLogInboxPayload', () => {
  it('carries log text plus version plus timestamp, kind, and lines', () => {
    const payload = buildLogInboxPayload({
      logText: 'line one\nline two\n',
      version: '0.1.21',
      uploadedAt: '2026-11-04T07:30:00.000Z',
    });
    expect(payload).toEqual({
      log: 'line one\nline two\n',
      version: '0.1.21',
      uploadedAt: '2026-11-04T07:30:00.000Z',
      kind: 'full',
      lines: 2,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'kind',
      'lines',
      'log',
      'uploadedAt',
      'version',
    ]);
  });

  it('throws on an empty log', () => {
    expect(() =>
      buildLogInboxPayload({ logText: '', version: '0.1.21', uploadedAt: '2026-11-04T07:30:00.000Z' }),
    ).toThrow('log is empty');
  });

  it('truncates an over-cap log to its tail instead of failing', () => {
    // Padded lines so the log genuinely exceeds the 2 MB cap: short
    // lines alone would need tens of thousands of them.
    const pad = 'x'.repeat(1100);
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `2026-11-04T07:30:00.000Z app line-${i} ${pad}`,
    );
    const big = `${lines.join('\n')}\n`;
    expect(logTextByteLength(big)).toBeGreaterThan(LOG_INBOX_MAX_BYTES);
    const payload = buildLogInboxPayload({
      logText: big,
      version: '0.1.21',
      uploadedAt: '2026-11-04T07:30:00.000Z',
    });
    expect(logTextByteLength(payload.log)).toBeLessThanOrEqual(LOG_INBOX_MAX_BYTES);
    expect(payload.log.startsWith('log truncated: original ')).toBe(true);
    expect(payload.log).toContain('line-1999');
    expect(payload.log).not.toContain('line-0 ');
    const storedLines = payload.log.split('\n').filter((l) => l.length > 0);
    expect(storedLines[storedLines.length - 1]).toBe(
      `2026-11-04T07:30:00.000Z app line-1999 ${pad}`,
    );
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
    expect(result).toEqual({
      id: 'k9f2mq7x',
      truncated: false,
      originalBytes: 9,
      kind: 'full',
      lines: 1,
    });
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
      kind: 'full',
      lines: 1,
    });
  });

  it('carries kind delta and lines through to the endpoint', async () => {
    const fetchFn = fetchReturning(okResponse({ id: 'delta1' }));
    const result = await sendDiagnosticsLogToInbox(
      { ...input, logText: 'new one\nnew two\n', kind: 'delta', lines: 2 },
      fetchFn as never,
    );
    expect(result.kind).toBe('delta');
    expect(result.lines).toBe(2);
    const [, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(JSON.parse(init.body)).toEqual({
      log: 'new one\nnew two\n',
      version: '0.1.21',
      uploadedAt: '2026-11-04T07:30:00.000Z',
      kind: 'delta',
      lines: 2,
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

describe('parseLogInboxWatermark', () => {
  it('round-trips a valid watermark', () => {
    const watermark: LogInboxWatermark = {
      v: 1,
      offsetBytes: 123,
      headLine: '2026-11-05T10:00:00.000Z app started',
    };
    expect(parseLogInboxWatermark(JSON.stringify(watermark))).toEqual(watermark);
  });

  it('rejects anything malformed', () => {
    expect(parseLogInboxWatermark(null)).toBeNull();
    expect(parseLogInboxWatermark('not json')).toBeNull();
    expect(parseLogInboxWatermark('{}')).toBeNull();
    expect(parseLogInboxWatermark(JSON.stringify({ v: 2, offsetBytes: 1, headLine: 'x' }))).toBeNull();
    expect(parseLogInboxWatermark(JSON.stringify({ v: 1, offsetBytes: -1, headLine: 'x' }))).toBeNull();
    expect(
      parseLogInboxWatermark(JSON.stringify({ v: 1, offsetBytes: 1.5, headLine: 'x' })),
    ).toBeNull();
    expect(parseLogInboxWatermark(JSON.stringify({ v: 1, offsetBytes: 1, headLine: 7 }))).toBeNull();
  });
});

describe('sliceLogTextFromByteOffset', () => {
  it('slices whole lines from a byte offset', () => {
    expect(sliceLogTextFromByteOffset('aaa\nbbb\nccc\n', logTextByteLength('aaa\n'))).toBe(
      'bbb\nccc\n',
    );
    expect(sliceLogTextFromByteOffset('aaa\nbbb\nccc\n', 0)).toBe('aaa\nbbb\nccc\n');
    expect(sliceLogTextFromByteOffset('aaa\nbbb\nccc\n', 999)).toBe('');
  });

  it('drops a partial first line when the offset lands mid-line', () => {
    // Offset inside 'bbb': the byte before it is not a newline, so the
    // fragment is dropped and the slice starts at the next whole line.
    expect(sliceLogTextFromByteOffset('aaa\nbbb\nccc\n', logTextByteLength('aaa\nb'))).toBe(
      'ccc\n',
    );
  });

  it('slices multi-byte characters by UTF-8 bytes, not code units', () => {
    const text = 'aé\nb\nc\n';
    // 'aé\n' is 4 UTF-8 bytes; a code-unit offset would land inside 'é'.
    expect(sliceLogTextFromByteOffset(text, 4)).toBe('b\nc\n');
    expect(sliceLogTextFromByteOffset(text, logTextByteLength('aé\nb\n'))).toBe('c\n');
  });
});

describe('planLogInboxUpload', () => {
  const oldLog =
    '2026-11-05T10:00:00.000Z app line one\n2026-11-05T10:00:01.000Z app line two\n';
  const appended = '2026-11-05T10:00:02.000Z app line three\n';
  const full = oldLog + appended;

  const watermarkFor = (text: string): LogInboxWatermark => ({
    v: 1,
    offsetBytes: logTextByteLength(text),
    headLine: text.split('\n')[0],
  });

  it('uploads the whole file once when no watermark exists', () => {
    const plan = planLogInboxUpload(full, null);
    expect(plan.plan).toBe('upload');
    if (plan.plan !== 'upload') throw new Error('unreachable');
    expect(plan.kind).toBe('full');
    expect(plan.text).toBe(full);
    expect(plan.lines).toBe(3);
    expect(plan.newWatermark).toEqual(watermarkFor(full));
  });

  it('uploads only the appended lines when the watermark matches', () => {
    const plan = planLogInboxUpload(full, watermarkFor(oldLog));
    expect(plan.plan).toBe('upload');
    if (plan.plan !== 'upload') throw new Error('unreachable');
    expect(plan.kind).toBe('delta');
    expect(plan.text).toBe(appended);
    expect(plan.lines).toBe(1);
    expect(plan.truncated).toBe(false);
    expect(plan.newWatermark).toEqual(watermarkFor(full));
  });

  it('plans nothing when zero new lines exist', () => {
    expect(planLogInboxUpload(oldLog, watermarkFor(oldLog))).toEqual({
      plan: 'none',
      kind: null,
      lines: 0,
    });
  });

  it('falls back to a full upload when the head line changed (rotation)', () => {
    const rotated = { ...watermarkFor(oldLog), headLine: '2026-11-05T09:00:00.000Z app older' };
    const plan = planLogInboxUpload(full, rotated);
    expect(plan.plan).toBe('upload');
    if (plan.plan !== 'upload') throw new Error('unreachable');
    expect(plan.kind).toBe('full');
    expect(plan.text).toBe(full);
  });

  it('falls back to a full upload when the file shrank below the watermark', () => {
    const shrunk: LogInboxWatermark = {
      v: 1,
      offsetBytes: logTextByteLength(full) + 100,
      headLine: full.split('\n')[0],
    };
    const plan = planLogInboxUpload(oldLog, shrunk);
    expect(plan.plan).toBe('upload');
    if (plan.plan !== 'upload') throw new Error('unreachable');
    expect(plan.kind).toBe('full');
    expect(plan.text).toBe(oldLog);
  });

  it('still truncates an oversized delta to its tail', () => {
    const pad = 'x'.repeat(1100);
    const bigOld = `${Array.from(
      { length: 1500 },
      (_, i) => `2026-11-05T10:00:00.000Z app old-${i} ${pad}`,
    ).join('\n')}\n`;
    const bigNew = `${Array.from(
      { length: 2000 },
      (_, i) => `2026-11-05T10:01:00.000Z app new-${i} ${pad}`,
    ).join('\n')}\n`;
    expect(logTextByteLength(bigNew)).toBeGreaterThan(LOG_INBOX_MAX_BYTES);
    const plan = planLogInboxUpload(bigOld + bigNew, watermarkFor(bigOld));
    expect(plan.plan).toBe('upload');
    if (plan.plan !== 'upload') throw new Error('unreachable');
    expect(plan.kind).toBe('delta');
    expect(plan.truncated).toBe(true);
    expect(logTextByteLength(plan.text)).toBeLessThanOrEqual(LOG_INBOX_MAX_BYTES);
    expect(plan.text.startsWith('log truncated: original ')).toBe(true);
    expect(plan.text).toContain('new-1999');
    expect(plan.text).not.toContain('old-0 ');
  });

  it('counts lines in the stored text', () => {
    expect(countLogLines('')).toBe(0);
    expect(countLogLines('one\ntwo\nthree\n')).toBe(3);
    expect(countLogLines('one\ntwo\n')).toBe(2);
  });
});

describe('log inbox watermark store', () => {
  it('initializes to end of file once and never overwrites', async () => {
    const kv = new MemoryKv();
    expect(await readLogInboxWatermark(kv)).toBeNull();
    expect(await initializeLogInboxWatermarkIfNeeded(kv, 1234, 'first line')).toBe(true);
    expect(await readLogInboxWatermark(kv)).toEqual({
      v: 1,
      offsetBytes: 1234,
      headLine: 'first line',
    });
    expect(await initializeLogInboxWatermarkIfNeeded(kv, 9999, 'other line')).toBe(false);
    expect(await readLogInboxWatermark(kv)).toEqual({
      v: 1,
      offsetBytes: 1234,
      headLine: 'first line',
    });
  });

  it('advances only on success: a failed send retries the same delta', async () => {
    const kv = new MemoryKv();
    const first =
      '2026-11-05T10:00:00.000Z app line one\n2026-11-05T10:00:01.000Z app line two\n';
    const second = '2026-11-05T10:00:02.000Z app line three\n';
    const full = first + second;

    // No watermark yet: one full upload, then anchor at end of file.
    const fullPlan = planLogInboxUpload(full, await readLogInboxWatermark(kv));
    expect(fullPlan.plan).toBe('upload');
    if (fullPlan.plan !== 'upload') throw new Error('unreachable');
    await writeLogInboxWatermark(kv, fullPlan.newWatermark);

    // More lines arrive; the plan is a delta of only those lines.
    const third = '2026-11-05T10:00:03.000Z app line four\n';
    const withThird = full + third;
    const deltaPlan = planLogInboxUpload(withThird, await readLogInboxWatermark(kv));
    expect(deltaPlan.plan).toBe('upload');
    if (deltaPlan.plan !== 'upload') throw new Error('unreachable');
    expect(deltaPlan.kind).toBe('delta');
    expect(deltaPlan.text).toBe(third);

    // The upload fails: the watermark is NOT advanced, so the next
    // Send plans the exact same delta again instead of losing it.
    const retryPlan = planLogInboxUpload(withThird, await readLogInboxWatermark(kv));
    expect(retryPlan).toEqual(deltaPlan);

    // The upload succeeds: the watermark advances, and a further Send
    // with no new lines plans nothing.
    await writeLogInboxWatermark(kv, deltaPlan.newWatermark);
    expect(planLogInboxUpload(withThird, await readLogInboxWatermark(kv))).toEqual({
      plan: 'none',
      kind: null,
      lines: 0,
    });
  });
});
