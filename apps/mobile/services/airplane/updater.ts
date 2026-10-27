// SPDX-License-Identifier: Apache-2.0
// T14 — in-app auto-update check from GitHub Releases (Android only).
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
// dependency) — this talks to the public GitHub API with no auth.

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

/** Pick the installable APK from a release's assets: prefer a `release`
 *  build over a debug one, otherwise the first `.apk` asset. Returns null
 *  when no asset is an APK (caller falls back to the release page). */
export const pickApkAsset = (assets: unknown): string | null => {
  if (!Array.isArray(assets)) return null;
  const apks = assets.filter(isRecord).filter((asset) => {
    const name = asString(asset.name);
    const url = asString(asset.browser_download_url);
    return name !== null && url !== null && name.toLowerCase().endsWith('.apk');
  });
  if (apks.length === 0) return null;
  const releaseBuild = apks.find((asset) => !String(asset.name).toLowerCase().includes('debug'));
  const picked = releaseBuild ?? apks[0];
  return asString(picked.browser_download_url);
};

/** Validate a `releases/latest` payload. Returns null for anything
 *  malformed (wrong shape, missing/unparseable tag, missing release URL)
 *  — never throws, so a bad response can never break launch. */
export const parseReleasePayload = (payload: unknown): UpdateInfo | null => {
  if (!isRecord(payload)) return null;
  const tag = asString(payload.tag_name);
  const releaseUrl = asString(payload.html_url);
  if (tag === null || releaseUrl === null) return null;
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
  } catch {
    return { available: false, error: 'check-failed' };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};
