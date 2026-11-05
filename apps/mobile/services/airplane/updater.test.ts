// SPDX-License-Identifier: Apache-2.0
// T14 tests: update detection, same/older ignored, failure tolerance.
// The pure updater never throws, so every failure case asserts a quiet
// `{ available: false }` - no crash, no prompt - exactly what launch needs.

import {
  apkFileNameFromUrl,
  checkForUpdate,
  compareVersions,
  expectedApkHash,
  fetchSha256Sums,
  fetchSha256SumsDetailed,
  isAllowedUpdateUrl,
  parseReleasePayload,
  parseSha256Sums,
  parseVersion,
  pickApkAsset,
  sumsDownloadUrl,
  type UpdateCheckResult,
} from './updater';

const releasePayload = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'v0.1.4',
  html_url: 'https://github.com/bunnysayzz/airplane/releases/tag/v0.1.4',
  assets: [
    {
      name: 'airplane-0.1.4-release.apk',
      browser_download_url:
        'https://github.com/bunnysayzz/airplane/releases/download/v0.1.4/airplane.apk',
    },
  ],
  ...overrides,
});

const okResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

const fetchReturning = (response: unknown) => jest.fn(async () => response);
const fetchThrowing = () =>
  jest.fn(async () => {
    throw new Error('network down');
  });

const check = (
  currentVersion: string,
  fetchImpl: (url: string) => Promise<unknown>,
): Promise<UpdateCheckResult> =>
  checkForUpdate({ currentVersion, fetchImpl: fetchImpl as never, timeoutMs: 1000 });

describe('parseVersion', () => {
  test('accepts v-prefixed, bare and short versions', () => {
    expect(parseVersion('v0.1.4')).toEqual([0, 1, 4]);
    expect(parseVersion('0.1.4')).toEqual([0, 1, 4]);
    expect(parseVersion('v0.1')).toEqual([0, 1, 0]);
    expect(parseVersion('v2')).toEqual([2, 0, 0]);
  });
  test('rejects non-versions', () => {
    expect(parseVersion('nightly')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('v1.2.x')).toBeNull();
    expect(parseVersion('0.1.4.5')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(5)).toBeNull();
  });
});

describe('compareVersions', () => {
  test('orders numerically, not lexicographically', () => {
    expect(compareVersions([0, 1, 9], [0, 1, 10])).toBe(-1);
    expect(compareVersions([0, 2, 0], [0, 1, 9])).toBe(1);
    expect(compareVersions([0, 1, 4], [0, 1, 4])).toBe(0);
  });
});

describe('pickApkAsset', () => {
  test('prefers a release build over a debug APK', () => {
    expect(
      pickApkAsset([
        { name: 'app-debug.apk', browser_download_url: 'https://github.com/bunnysayzz/airplane/releases/download/v0.1.4/debug.apk' },
        { name: 'app-release.apk', browser_download_url: 'https://github.com/bunnysayzz/airplane/releases/download/v0.1.4/release.apk' },
      ]),
    ).toBe('https://github.com/bunnysayzz/airplane/releases/download/v0.1.4/release.apk');
  });
  test('refuses APK assets off the allowlist', () => {
    expect(
      pickApkAsset([
        { name: 'app.apk', browser_download_url: 'https://evil.example/app.apk' },
        { name: 'app2.apk', browser_download_url: 'http://github.com/bunnysayzz/airplane/releases/download/v0.1.4/app.apk' },
      ]),
    ).toBeNull();
    expect(
      pickApkAsset([
        { name: 'app.apk', browser_download_url: 'https://objects.githubusercontent.com/abc/app.apk' },
      ]),
    ).toBe('https://objects.githubusercontent.com/abc/app.apk');
  });
  test('returns null with no APK asset', () => {
    expect(
      pickApkAsset([{ name: 'notes.txt', browser_download_url: 'https://example.test/n.txt' }]),
    ).toBeNull();
    expect(pickApkAsset(undefined)).toBeNull();
    expect(pickApkAsset('nope')).toBeNull();
  });
});

describe('parseReleasePayload', () => {
  test('parses a well-formed release', () => {
    expect(parseReleasePayload(releasePayload())).toEqual({
      version: '0.1.4',
      tag: 'v0.1.4',
      downloadUrl: 'https://github.com/bunnysayzz/airplane/releases/download/v0.1.4/airplane.apk',
      releaseUrl: 'https://github.com/bunnysayzz/airplane/releases/tag/v0.1.4',
    });
  });
  test('tolerates malformed payloads without throwing', () => {
    expect(parseReleasePayload(null)).toBeNull();
    expect(parseReleasePayload('v0.1.4')).toBeNull();
    expect(parseReleasePayload([])).toBeNull();
    expect(parseReleasePayload(releasePayload({ tag_name: undefined }))).toBeNull();
    expect(parseReleasePayload(releasePayload({ tag_name: 'nightly' }))).toBeNull();
    expect(parseReleasePayload(releasePayload({ html_url: undefined }))).toBeNull();
  });
  test('keeps the release even when it carries no APK asset', () => {
    const parsed = parseReleasePayload(releasePayload({ assets: [] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.downloadUrl).toBeNull();
  });
  test('refuses release pages and downloads off the allowlist', () => {
    expect(parseReleasePayload(releasePayload({ html_url: 'https://evil.example/r' }))).toBeNull();
    expect(
      parseReleasePayload(releasePayload({ html_url: 'https://user:pass@github.com/x/y' })),
    ).toBeNull();
    const parsed = parseReleasePayload(
      releasePayload({
        assets: [
          { name: 'app.apk', browser_download_url: 'https://evil.example/app.apk' },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.downloadUrl).toBeNull();
    expect(parsed?.releaseUrl).toContain('github.com');
    expect(isAllowedUpdateUrl('https://github.com/bunnysayzz/airplane/releases/tag/v0.1.4')).toBe(true);
    expect(isAllowedUpdateUrl('https://evil.example/x')).toBe(false);
    expect(isAllowedUpdateUrl('http://github.com/x')).toBe(false);
    expect(isAllowedUpdateUrl(null)).toBe(false);
  });
});

describe('checkForUpdate', () => {
  test('newer release detected', async () => {
    const result = await check('0.1.3', fetchReturning(okResponse(releasePayload())));
    expect(result.available).toBe(true);
    expect(result.update?.version).toBe('0.1.4');
    expect(result.update?.downloadUrl).toContain('.apk');
  });
  test('same release ignored', async () => {
    const result = await check('0.1.4', fetchReturning(okResponse(releasePayload())));
    expect(result).toEqual({ available: false });
  });
  test('older release ignored', async () => {
    const result = await check('0.2.0', fetchReturning(okResponse(releasePayload())));
    expect(result).toEqual({ available: false });
  });
  test('unparseable installed version never prompts', async () => {
    const result = await check('unknown', fetchReturning(okResponse(releasePayload())));
    expect(result.available).toBe(false);
  });
  test('network failure tolerated: no crash, no prompt, with its own code', async () => {
    const result = await check('0.1.3', fetchThrowing());
    expect(result.available).toBe(false);
    expect(result.error).toBe('check-unreachable');
  });
  test('timeout gets its own code, not check-failed', async () => {
    const result = await check(
      '0.1.3',
      jest.fn(() => new Promise(() => {})),
    );
    expect(result.available).toBe(false);
    expect(result.error).toBe('check-timeout');
  });
  test('a JSON SyntaxError maps to malformed-release, not check-failed', async () => {
    const result = await check(
      '0.1.3',
      fetchReturning({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    );
    expect(result.available).toBe(false);
    expect(result.error).toBe('malformed-release');
  });
  test('non-2xx tolerated: no crash, no prompt', async () => {
    const result = await check(
      '0.1.3',
      fetchReturning({ ok: false, status: 403, json: async () => ({ message: 'rate limited' }) }),
    );
    expect(result.available).toBe(false);
    expect(result.error).toBe('http-403');
  });
  test('malformed release payload tolerated: no crash, no prompt', async () => {
    const badPayloads: unknown[] = [
      null,
      'garbage',
      { tag_name: 'nightly', html_url: 'https://example.test/r' },
      { html_url: 'https://example.test/r' },
    ];
    for (const payload of badPayloads) {
      const result = await check('0.1.3', fetchReturning(okResponse(payload)));
      expect(result.available).toBe(false);
      expect(result.error).toBe('malformed-release');
    }
  });
  test('bad JSON tolerated: no crash, no prompt', async () => {
    const result = await check(
      '0.1.3',
      fetchReturning({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json');
        },
      }),
    );
    expect(result.available).toBe(false);
    expect(result.error).toBe('check-failed');
  });
  test('release without an APK still reports, with a null download URL', async () => {
    const result = await check('0.1.3', fetchReturning(okResponse(releasePayload({ assets: [] }))));
    expect(result.available).toBe(true);
    expect(result.update?.downloadUrl).toBeNull();
    expect(result.update?.releaseUrl).toContain('/releases/tag/');
  });
});

describe('parseSha256Sums', () => {
  const sumsText = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  airplane-v0.1.21.apk',
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *airplane-v0.1.21.aab',
    '',
    'not-a-hash  airplane-v0.1.21.apk',
    'short  x.apk',
  ].join('\n');
  test('parses two-space and binary-mode lines, lowercases hashes', () => {
    const sums = parseSha256Sums(sumsText);
    expect(sums.get('airplane-v0.1.21.apk')).toBe('a'.repeat(64));
    expect(sums.get('airplane-v0.1.21.aab')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
  });
  test('CRLF endings and surrounding whitespace tolerated', () => {
    const sums = parseSha256Sums('c'.repeat(64) + '  x.apk\r\n');
    expect(sums.get('x.apk')).toBe('c'.repeat(64));
  });
  test('non-string input yields an empty map, never throws', () => {
    expect(parseSha256Sums(null).size).toBe(0);
    expect(parseSha256Sums(42).size).toBe(0);
  });
});

describe('expectedApkHash', () => {
  const sums = new Map([
    ['airplane-v0.1.21.apk', 'a'.repeat(64)],
    ['nested/dir/app.apk', 'b'.repeat(64)],
  ]);
  test('exact filename wins', () => {
    expect(expectedApkHash(sums, 'airplane-v0.1.21.apk')).toBe('a'.repeat(64));
  });
  test('basename fallback for pathed entries', () => {
    expect(expectedApkHash(sums, 'app.apk')).toBe('b'.repeat(64));
  });
  test('missing entry yields null', () => {
    expect(expectedApkHash(sums, 'nope.apk')).toBeNull();
  });
});

describe('apkFileNameFromUrl', () => {
  test('basename of an APK URL', () => {
    expect(
      apkFileNameFromUrl('https://github.com/bunnysayzz/airplane/releases/download/v0.1.21/airplane-v0.1.21.apk'),
    ).toBe('airplane-v0.1.21.apk');
  });
  test('non-APK and malformed URLs yield null', () => {
    expect(apkFileNameFromUrl('https://github.com/bunnysayzz/airplane/releases/tag/v0.1.21')).toBeNull();
    expect(apkFileNameFromUrl('not a url')).toBeNull();
  });
});

describe('sumsDownloadUrl', () => {
  test('points at the release SHA256SUMS.txt asset', () => {
    expect(sumsDownloadUrl('v0.1.21')).toBe(
      'https://github.com/bunnysayzz/airplane/releases/download/v0.1.21/SHA256SUMS.txt',
    );
  });
});

describe('fetchSha256SumsDetailed', () => {
  const instantSleep = () => Promise.resolve();
  const textResponse = (text: string) => ({
    ok: true,
    status: 200,
    text: async () => text,
  });
  const sumsLine = `${'e'.repeat(64)}  airplane-v0.1.21.apk\n`;
  const detailed = (tag: string, fetchImpl: (url: string) => Promise<unknown>, extra = {}) =>
    fetchSha256SumsDetailed(tag, {
      fetchImpl: fetchImpl as never,
      timeoutMs: 1000,
      sleepImpl: instantSleep,
      ...extra,
    });

  test('retry succeeds on the second attempt and records both attempts', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return textResponse(sumsLine);
    });
    const result = await detailed('v0.1.21', fn);
    expect(result.sums?.get('airplane-v0.1.21.apk')).toBe('e'.repeat(64));
    expect(result.lastReason).toBe('ok');
    expect(result.attempts).toEqual([
      { source: 'download', attempt: 1, ok: false, reason: 'network:Error' },
      { source: 'download', attempt: 2, ok: true, reason: 'ok' },
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('primary exhaustion falls back to the API asset route, same file', async () => {
    const apiPayload = {
      assets: [
        {
          name: 'SHA256SUMS.txt',
          browser_download_url:
            'https://objects.githubusercontent.com/abc/SHA256SUMS.txt',
        },
      ],
    };
    const fn = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.github.com/')) {
        return { ok: true, status: 200, json: async () => apiPayload };
      }
      if (url.startsWith('https://objects.githubusercontent.com/')) {
        return textResponse(sumsLine);
      }
      return { ok: false, status: 404, text: async () => '' };
    });
    const result = await detailed('v0.1.21', fn);
    expect(result.sums?.get('airplane-v0.1.21.apk')).toBe('e'.repeat(64));
    expect(result.lastReason).toBe('ok');
    expect(result.attempts.map((a) => `${a.source}:${a.attempt}:${a.ok}`)).toEqual([
      'download:1:false',
      'download:2:false',
      'download:3:false',
      'api-meta:1:true',
      'api-file:1:true',
    ]);
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining('https://api.github.com/repos/bunnysayzz/airplane/releases/tags/v0.1.21'),
      expect.anything(),
    );
  });

  test('all sources failing carries the last reason, never throws', async () => {
    // The mock carries json as well as text: a real API 404 is a JSON
    // response, and the meta path checks for it before reading status.
    const fn = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => ({}),
    }));
    const result = await detailed('v0.1.21', fn);
    expect(result.sums).toBeNull();
    expect(result.lastReason).toBe('http-404');
    expect(result.attempts[result.attempts.length - 1]).toEqual({
      source: 'api-meta',
      attempt: 1,
      ok: false,
      reason: 'http-404',
    });
  });

  test('a hanging fetch times out with the timeout value in the reason', async () => {
    const fn = jest.fn(() => new Promise(() => {}));
    const result = await detailed('v0.1.21', fn, { downloadAttempts: 1, timeoutMs: 50 });
    expect(result.sums).toBeNull();
    expect(result.lastReason).toBe('timeout:50ms');
    expect(result.attempts[0]).toEqual({
      source: 'download',
      attempt: 1,
      ok: false,
      reason: 'timeout:50ms',
    });
  });

  test('garbage body is unparseable, not a success', async () => {
    const fn = jest.fn(async () => textResponse('not a sums file\n'));
    const result = await detailed('v0.1.21', fn, { downloadAttempts: 1 });
    expect(result.sums).toBeNull();
    expect(result.attempts[0].reason).toBe('unparseable');
  });

  test('an off-allowlist API asset URL is ignored, never fetched', async () => {
    const apiPayload = {
      assets: [
        {
          name: 'SHA256SUMS.txt',
          browser_download_url: 'https://evil.example/SHA256SUMS.txt',
        },
      ],
    };
    const fn = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.github.com/')) {
        return { ok: true, status: 200, json: async () => apiPayload };
      }
      return { ok: false, status: 404, text: async () => '' };
    });
    const result = await detailed('v0.1.21', fn);
    expect(result.sums).toBeNull();
    expect(result.lastReason).toBe('no-sums-asset');
    expect(fn.mock.calls.every(([url]) => !(url as string).includes('evil.example'))).toBe(true);
  });
});

describe('fetchSha256Sums', () => {
  const textResponse = (text: string) => ({
    ok: true,
    status: 200,
    text: async () => text,
  });
  test('fetches the sums URL and parses entries', async () => {
    const fn = jest.fn(async () => textResponse(`${'d'.repeat(64)}  airplane-v0.1.21.apk\n`));
    const sums = await fetchSha256Sums('v0.1.21', { fetchImpl: fn as never, timeoutMs: 1000 });
    expect(fn).toHaveBeenCalledWith(
      'https://github.com/bunnysayzz/airplane/releases/download/v0.1.21/SHA256SUMS.txt',
      expect.anything(),
    );
    expect(sums?.get('airplane-v0.1.21.apk')).toBe('d'.repeat(64));
  });
  test('non-OK and throwing fetch yield null, never throw', async () => {
    // Instant backoff: the default retry path would sleep 500 + 1500 ms
    // per call, which is real time the test does not need to spend.
    const instantSleep = () => Promise.resolve();
    const notOk = await fetchSha256Sums('v0.1.21', {
      fetchImpl: jest.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as never,
      timeoutMs: 1000,
      sleepImpl: instantSleep,
    });
    expect(notOk).toBeNull();
    const throwing = await fetchSha256Sums('v0.1.21', {
      fetchImpl: fetchThrowing() as never,
      timeoutMs: 1000,
      sleepImpl: instantSleep,
    });
    expect(throwing).toBeNull();
  });
});
