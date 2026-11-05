// SPDX-License-Identifier: Apache-2.0
// T14 - in-app auto-update check from GitHub Releases (Android only).
//
// Pure logic, no react-native / expo imports, so it runs in the node Jest
// harness and can never crash launch: every failure path returns
// `{ available: false }` instead of throwing.
//
// Version comparison, stated plainly because the GitHub API forces it:
// the public releases API exposes a tag (e.g. `v0.1.4`) and assets, but NO
// versionCode. There is therefore no release-side versionCode to compare
// the installed versionCode against. PL1: app.json `version` is the single
// source of truth, and build.gradle derives versionName and versionCode
// from it, so the installed version always matches the release line the
// build was cut from. The comparison is semver tag vs the installed app
// version (app.json `version`, expo-constants `expoConfig` `version`, the
// same string the Settings screen already shows via `appVersionLabel()`).
// Additionally, this project has no expo-application dependency, so the
// installed versionCode is not even visible to JS; adding that dependency
// would surface it for display only and still would not make it comparable
// to a tag. Any future scheme that encodes the versionCode in a release
// (asset name, body) would need its own parser here, and must not be
// guessed at from tag strings.
//
// iOS: deliberately not supported. A sideloaded iOS app cannot install
// itself (no APK-style install intent, no App Store path for this build),
// so the caller returns early on iOS and no iOS updater is built here.
// EAS Update is not the route either (EAS abandoned; no Expo-cloud
// dependency) - this talks to the public GitHub API with no auth.

export const RELEASES_REPO = 'bunnysayzz/airplane';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

// GitHub's unauthenticated rate limit is low but a single check on launch
// plus a manual check from Settings is far inside it; a 403/429 is treated
// like any other failed check (no prompt, no crash).
export const CHECK_TIMEOUT_MS = 10_000;

export type Semver = [number, number, number];

export interface UpdateInfo {
  /** Normalised `x.y.z` version of the release tag. */
  version: string;
  /** Raw release tag, e.g. `v0.1.4`. */
  tag: string;
  /** Direct APK download URL, or null when the release has no APK asset
   *  (the caller then falls back to opening the release page). */
  downloadUrl: string | null;
  /** Human-readable release page, for the no-APK fallback and for notes. */
  releaseUrl: string;
}

export interface UpdateCheckResult {
  available: boolean;
  update?: UpdateInfo;
  /** Present whenever available is false for a reason other than
   *  "installed version is current" (network error, bad payload, ...).
   *  Callers log it at most; they never show it as a crash. */
  error?: string;
}

/** `v0.1.4`, `0.1.4`, `v0.1` -> `[0, 1, 4]` / `[0, 1, 0]`. Anything else
 *  (empty, `nightly`, `0.1.4.5`, `v1.2.x`) -> null. Pre-release/build
 *  suffixes (`-beta.1`, `+abc`) are ignored: a tagged release is a
 *  release, and the numeric prefix is what orders it. */
export const parseVersion = (tag: unknown): Semver | null => {
  if (typeof tag !== 'string') return null;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(tag.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
};

export const formatVersion = (version: Semver): string => version.join('.');

/** -1 if a < b, 0 if equal, 1 if a > b. */
export const compareVersions = (a: Semver, b: Semver): number => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Update URL allowlist. Only https URLs on the hosts GitHub actually
 * serves releases from are openable: github.com for release pages and
 * APK downloads, plus objects.githubusercontent.com for APK assets.
 * Anything else (http, other hosts, embedded credentials, non-URL
 * strings) is refused, so a compromised releases payload cannot make
 * the app open an arbitrary link on the user's tap.
 */
export const isAllowedUpdateUrl = (
  url: string | null,
  opts: { downloadHost?: boolean } = {},
): boolean => {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'github.com') return true;
    if (opts.downloadHost === true && host === 'objects.githubusercontent.com') return true;
    return false;
  } catch {
    return false;
  }
};

/** Pick the installable APK from a release's assets: prefer a `release`
 *  build over a debug one, otherwise the first `.apk` asset. Returns null
 *  when no asset is an APK (caller falls back to the release page).
 *  An asset URL is accepted only when it passes the update allowlist
 *  (https, github.com or objects.githubusercontent.com): a tampered
 *  releases payload must never steer the app at an arbitrary URL. */
export const pickApkAsset = (assets: unknown): string | null => {
  if (!Array.isArray(assets)) return null;
  const apks = assets.filter(isRecord).filter((asset) => {
    const name = asString(asset.name);
    const url = asString(asset.browser_download_url);
    return (
      name !== null &&
      url !== null &&
      name.toLowerCase().endsWith('.apk') &&
      isAllowedUpdateUrl(url, { downloadHost: true })
    );
  });
  if (apks.length === 0) return null;
  const releaseBuild = apks.find((asset) => !String(asset.name).toLowerCase().includes('debug'));
  const picked = releaseBuild ?? apks[0];
  return asString(picked.browser_download_url);
};

/** Validate a `releases/latest` payload. Returns null for anything
 *  malformed (wrong shape, missing/unparseable tag, missing release URL)
 *  - never throws, so a bad response can never break launch. */
export const parseReleasePayload = (payload: unknown): UpdateInfo | null => {
  if (!isRecord(payload)) return null;
  const tag = asString(payload.tag_name);
  const releaseUrl = asString(payload.html_url);
  if (tag === null || releaseUrl === null) return null;
  // The release page URL comes from the same untrusted payload as the
  // assets: it must pass the allowlist or the payload is unusable.
  if (!isAllowedUpdateUrl(releaseUrl)) return null;
  const version = parseVersion(tag);
  if (version === null) return null;
  return {
    version: formatVersion(version),
    tag,
    downloadUrl: pickApkAsset(payload.assets),
    releaseUrl,
  };
};

export interface CheckForUpdateOptions {
  /** Installed version string, e.g. `0.1.3` (see header note). */
  currentVersion: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: (
    url: string,
    init?: { headers?: Record<string, string>; signal?: unknown },
  ) => Promise<unknown>;
  /** Injectable for tests; defaults to CHECK_TIMEOUT_MS. */
  timeoutMs?: number;
}

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const isFetchResponse = (value: unknown): value is FetchResponse =>
  isRecord(value) &&
  typeof value.ok === 'boolean' &&
  typeof value.status === 'number' &&
  typeof value.json === 'function';

/**
 * Check the latest public release. Never throws: network failure, timeout,
 * non-2xx status, unparseable JSON and malformed payloads all resolve to
 * `{ available: false }` with an `error` note. A newer release is reported
 * only when its tag parses AND is strictly greater than the installed
 * version; same/older releases, and an unparseable installed version
 * (e.g. `unknown`), never prompt.
 */
export const checkForUpdate = async (
  options: CheckForUpdateOptions,
): Promise<UpdateCheckResult> => {
  const { currentVersion, timeoutMs = CHECK_TIMEOUT_MS } = options;
  const current = parseVersion(currentVersion);
  if (current === null) return { available: false, error: 'unknown-current-version' };

  const fetchFn =
    options.fetchImpl ??
    ((typeof globalThis.fetch === 'function'
      ? globalThis.fetch
      : null) as CheckForUpdateOptions['fetchImpl']);
  if (typeof fetchFn !== 'function') return { available: false, error: 'fetch-unavailable' };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new Error('check-timeout'));
      }, timeoutMs);
    });
    const response = (await Promise.race([
      fetchFn(LATEST_RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller?.signal,
      }),
      timeout,
    ])) as unknown;
    if (!isFetchResponse(response)) return { available: false, error: 'bad-response' };
    if (!response.ok) return { available: false, error: `http-${response.status}` };
    const payload = await response.json();
    const release = parseReleasePayload(payload);
    if (release === null) return { available: false, error: 'malformed-release' };
    const latest = parseVersion(release.tag);
    if (latest === null) return { available: false, error: 'malformed-release' };
    if (compareVersions(latest, current) <= 0) return { available: false };
    return { available: true, update: release };
  } catch (error: unknown) {
    return { available: false, error: classifyCheckError(error) };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

/**
 * Classify a check failure into a distinct reason code for the
 * update check failed line. The v0.1.23 log showed only
 * check-failed for a launch check 76 ms after start (the phone
 * offline, network never validated), which cannot distinguish
 * offline from a slow server from a broken payload. Timeout, HTTP
 * status (http-<status>, returned above, not here) and malformed
 * payload (malformed-release, returned above, plus JSON parse
 * failures here) each keep their own code; only a truly
 * unclassified failure stays check-failed.
 */
function classifyCheckError(error: unknown): string {
  if (error instanceof SyntaxError) return 'malformed-release';
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'check-timeout' || /timed out|timeout/i.test(message)) return 'check-timeout';
  if (
    /network|failed to fetch|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|offline|not reachable|network request failed/i.test(
      message,
    )
  ) {
    return 'check-unreachable';
  }
  return 'check-failed';
}

/**
 * T14 in-app install: the release's SHA256SUMS.txt asset. Every release
 * publishes one (see publish-test-apk.yml), so a downloaded APK is never
 * installed on trust alone: its SHA-256 must match the sums file entry
 * for its filename. The URL is constructed, never taken from a payload,
 * and still passes the update allowlist before use.
 */
export const sumsDownloadUrl = (tag: string): string =>
  `https://github.com/${RELEASES_REPO}/releases/download/${tag}/SHA256SUMS.txt`;

/**
 * Parse a sha256sum file: "<64 hex>  <name>" lines (two spaces, or the
 * " *" binary-mode separator). Malformed lines are ignored, never fatal.
 * Hashes are normalised to lowercase; filenames are kept as written.
 */
export const parseSha256Sums = (text: unknown): Map<string, string> => {
  const out = new Map<string, string>();
  if (typeof text !== 'string') return out;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line);
    if (!match) continue;
    out.set(match[2].trim(), match[1].toLowerCase());
  }
  return out;
};

/** Expected hash for an APK file: exact filename first, then any entry
 *  whose basename matches the wanted basename. Sums files list basenames
 *  in practice, but a pathed entry must still match a bare filename. */
export const expectedApkHash = (
  sums: Map<string, string>,
  apkFileName: string,
): string | null => {
  const direct = sums.get(apkFileName);
  if (direct !== undefined) return direct;
  const wantedBase = apkFileName.split('/').filter(Boolean).pop();
  if (wantedBase === undefined) return null;
  const byBase = sums.get(wantedBase);
  if (byBase !== undefined) return byBase;
  for (const [entry, hash] of sums) {
    if (entry.split('/').filter(Boolean).pop() === wantedBase) return hash;
  }
  return null;
};

/** Basename of an APK download URL, or null when it is not an APK URL. */
export const apkFileNameFromUrl = (url: string): string | null => {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? null;
    return name !== null && name.toLowerCase().endsWith('.apk') ? name : null;
  } catch {
    return null;
  }
};

type TextResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

const isTextResponse = (value: unknown): value is TextResponse =>
  isRecord(value) &&
  typeof value.ok === 'boolean' &&
  typeof value.status === 'number' &&
  typeof value.text === 'function';

/**
 * Fetch and parse the release's SHA256SUMS.txt, with retries and a
 * fallback source, but never a bypass. The v0.1.25 rollout stranded one
 * phone on v0.1.24: its JS fetch of the sums file failed three times
 * while the native APK download and relay connections worked, and the
 * old code swallowed the underlying error, so the log line carried only
 * `no-sums` and the user had no way forward inside the app. This
 * version therefore (a) retries the primary download URL up to
 * `downloadAttempts` times with backoff, (b) falls back to the release
 * assets API route for the same file, and (c) reports every attempt
 * with its outcome and reason, so the next failure is diagnosable from
 * logs alone. A missing sums file still aborts the install: it never
 * falls back to installing unchecked, and no caller may skip the hash
 * match on the strength of this result.
 */
export type SumsFetchAttempt = {
  /** Which source was tried: the direct download URL, the API metadata
   *  lookup for the sums asset, or the asset file itself. */
  source: 'download' | 'api-meta' | 'api-file';
  /** 1-based attempt number within that source. */
  attempt: number;
  ok: boolean;
  /** 'ok' on success, else a greppable reason: `timeout:<ms>`,
   *  `http-<status>`, `network:<ErrorName>`, `bad-response`,
   *  `unparseable`, `no-sums-asset`, `no-fetch`, `url-not-allowed`,
   *  or `fetch-error`. */
  reason: string;
};

export type SumsFetchResult = {
  /** Parsed sums, or null when every source failed. */
  sums: Map<string, string> | null;
  /** Every attempt made, in order. */
  attempts: SumsFetchAttempt[];
  /** 'ok' when sums were found, else the reason of the last attempt. */
  lastReason: string;
};

type FetchSumsOptions = {
  fetchImpl?: (
    url: string,
    init?: { headers?: Record<string, string>; signal?: unknown },
  ) => Promise<unknown>;
  timeoutMs?: number;
  /** Primary-download attempts before the API fallback (default 3). */
  downloadAttempts?: number;
  /** Backoff delays between primary attempts, in ms (default
   *  [500, 1500]); the last value repeats when attempts outrun the list. */
  backoffMs?: number[];
  /** Injectable sleep for tests; defaults to a real timer sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
};

type FetchFn = NonNullable<FetchSumsOptions['fetchImpl']>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Classify a thrown fetch error into a greppable reason. The timeout
 *  the race itself raises is classified by the caller as
 *  `timeout:<ms>`; anything else that looks like a timeout lands here
 *  as plain `timeout`. */
const classifySumsThrow = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (
    /network|failed to fetch|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|offline|not reachable|network request failed/i.test(
      message,
    )
  ) {
    return `network:${error instanceof Error ? error.name : 'Error'}`;
  }
  return 'fetch-error';
};

/** One fetch with a timeout race. Returns the raw response, or a
 *  failure reason; never throws. */
const fetchWithTimeout = async (
  url: string,
  fetchFn: FetchFn,
  timeoutMs: number,
  init?: { headers?: Record<string, string> },
): Promise<{ response: unknown } | { failure: string }> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new Error('sums-timeout'));
      }, timeoutMs);
    });
    const response = await Promise.race([
      fetchFn(url, { ...init, signal: controller?.signal }),
      timeout,
    ]);
    return { response };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'sums-timeout') {
      return { failure: `timeout:${timeoutMs}ms` };
    }
    return { failure: classifySumsThrow(error) };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

/** Fetch one sums file body: the response must be a 2xx text response
 *  carrying at least one valid entry, else the attempt failed with a
 *  reason. An empty or garbage body is `unparseable`, not a success:
 *  the old code returned its empty map, which failed closed downstream
 *  but hid the cause behind `no-sums`. */
const fetchSumsBody = async (
  url: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<{ sums: Map<string, string> } | { failure: string }> => {
  const fetched = await fetchWithTimeout(url, fetchFn, timeoutMs);
  if ('failure' in fetched) return { failure: fetched.failure };
  if (!isTextResponse(fetched.response)) return { failure: 'bad-response' };
  if (!fetched.response.ok) return { failure: `http-${fetched.response.status}` };
  let text: string;
  try {
    text = await fetched.response.text();
  } catch (error: unknown) {
    return { failure: classifySumsThrow(error) };
  }
  const sums = parseSha256Sums(text);
  if (sums.size === 0) return { failure: 'unparseable' };
  return { sums };
};

/** Find the SHA256SUMS.txt asset URL in a releases API payload, after
 *  the same allowlist the APK picker uses. A payload-steered arbitrary
 *  URL must never be fetched. */
const sumsAssetUrlFromPayload = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;
  const assets = payload.assets;
  if (!Array.isArray(assets)) return null;
  for (const asset of assets) {
    if (!isRecord(asset)) continue;
    if (asString(asset.name) !== 'SHA256SUMS.txt') continue;
    const url = asString(asset.browser_download_url);
    if (url !== null && isAllowedUpdateUrl(url, { downloadHost: true })) return url;
  }
  return null;
};

export const fetchSha256SumsDetailed = async (
  tag: string,
  options: FetchSumsOptions = {},
): Promise<SumsFetchResult> => {
  const {
    timeoutMs = CHECK_TIMEOUT_MS,
    downloadAttempts = 3,
    backoffMs = [500, 1500],
    sleepImpl = defaultSleep,
  } = options;
  const attempts: SumsFetchAttempt[] = [];
  const fail = (lastReason: string): SumsFetchResult => ({ sums: null, attempts, lastReason });
  const fetchFn =
    options.fetchImpl ??
    ((typeof globalThis.fetch === 'function'
      ? globalThis.fetch
      : null) as FetchSumsOptions['fetchImpl']);
  if (typeof fetchFn !== 'function') {
    attempts.push({ source: 'download', attempt: 1, ok: false, reason: 'no-fetch' });
    return fail('no-fetch');
  }
  const primaryUrl = sumsDownloadUrl(tag);
  if (!isAllowedUpdateUrl(primaryUrl)) {
    attempts.push({ source: 'download', attempt: 1, ok: false, reason: 'url-not-allowed' });
    return fail('url-not-allowed');
  }
  for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
    const body = await fetchSumsBody(primaryUrl, fetchFn, timeoutMs);
    if ('sums' in body) {
      attempts.push({ source: 'download', attempt, ok: true, reason: 'ok' });
      return { sums: body.sums, attempts, lastReason: 'ok' };
    }
    attempts.push({ source: 'download', attempt, ok: false, reason: body.failure });
    if (attempt < downloadAttempts) {
      await sleepImpl(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0);
    }
  }
  // Alternate source, same file, different host path: the public
  // releases API route for this tag. The tag is encoded, the asset URL
  // passes the allowlist, and the content is verified exactly like the
  // primary body, so this changes availability, not trust.
  const apiUrl = `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const meta = await fetchWithTimeout(
    apiUrl,
    fetchFn,
    timeoutMs,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if ('failure' in meta) {
    attempts.push({ source: 'api-meta', attempt: 1, ok: false, reason: meta.failure });
    return fail(meta.failure);
  }
  if (!isFetchResponse(meta.response)) {
    attempts.push({ source: 'api-meta', attempt: 1, ok: false, reason: 'bad-response' });
    return fail('bad-response');
  }
  if (!meta.response.ok) {
    attempts.push({ source: 'api-meta', attempt: 1, ok: false, reason: `http-${meta.response.status}` });
    return fail(`http-${meta.response.status}`);
  }
  let payload: unknown;
  try {
    payload = await meta.response.json();
  } catch (error: unknown) {
    const reason = classifySumsThrow(error);
    attempts.push({ source: 'api-meta', attempt: 1, ok: false, reason });
    return fail(reason);
  }
  const assetUrl = sumsAssetUrlFromPayload(payload);
  if (assetUrl === null) {
    attempts.push({ source: 'api-meta', attempt: 1, ok: false, reason: 'no-sums-asset' });
    return fail('no-sums-asset');
  }
  attempts.push({ source: 'api-meta', attempt: 1, ok: true, reason: 'ok' });
  const body = await fetchSumsBody(assetUrl, fetchFn, timeoutMs);
  if ('sums' in body) {
    attempts.push({ source: 'api-file', attempt: 1, ok: true, reason: 'ok' });
    return { sums: body.sums, attempts, lastReason: 'ok' };
  }
  attempts.push({ source: 'api-file', attempt: 1, ok: false, reason: body.failure });
  return fail(body.failure);
};

/** Backwards-compatible wrapper: the parsed sums, or null when every
 *  source failed. Callers that need the reason use
 *  fetchSha256SumsDetailed instead. */
export const fetchSha256Sums = async (
  tag: string,
  options: FetchSumsOptions = {},
): Promise<Map<string, string> | null> => {
  const detailed = await fetchSha256SumsDetailed(tag, options);
  return detailed.sums;
};
