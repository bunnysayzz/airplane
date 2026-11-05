// SPDX-License-Identifier: Apache-2.0
// T14 - UI wiring for the GitHub-Releases update check (Android only).
//
// Launch safety is the whole point: every path here swallows errors, so a
// failed check, no network, or a bad response can never break launch. The
// prompt is advisory only - "Later" dismisses it, nothing installs silently
// and nothing is ever force-installed.
//
// iOS: this module is a no-op on iOS. A sideloaded iOS app cannot install
// itself (no install intent, no App Store path for this build), so no iOS
// updater is built; the Settings row is hidden on iOS (see settings.tsx).
//
// In-app install flow (Android): the "Download" button runs a permission
// gate first (REQUEST_INSTALL_PACKAGES, declared in app.json and
// AndroidManifest.xml). When the grant is missing, the user is sent to the
// system unknown-sources page for this app's own package, and the download
// resumes when the app returns to foreground. The native module then
// downloads the APK into a FileProvider cache dir, hashes it while it
// downloads, and JS compares that hash against the release's SHA256SUMS.txt
// entry for the picked APK filename. On mismatch the file is deleted and
// nothing installs. On match the system install sheet opens and the user
// taps Install. When the native module is unavailable for any reason, the
// flow falls back to opening the APK URL in the browser (the pre-v0.1.21
// behavior), never a dead button, and the same fallback applies when the
// install intent itself cannot fire. Honest ceiling: Android never allows a
// fully silent install for a sideloaded app; only Play can do that, and
// only for Play-installed apps.

import Constants from 'expo-constants';
import { AppState, Linking, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import {
  apkFileNameFromUrl,
  checkForUpdate,
  expectedApkHash,
  fetchSha256SumsDetailed,
  isAllowedUpdateUrl,
  type UpdateCheckResult,
  type UpdateInfo,
} from '../../services/airplane/updater';
import { recordUpdateEvent } from '../../services/airplane/diagnostics';
import { dialog } from './dialog';
import { defaultTranslator } from '../i18n/translate';

// Installed version source: the same source the Settings screen already
// shows (appVersionLabel): app.json `version` via expoConfig. PL1: app.json
// is the single source of truth, and build.gradle derives versionName and
// versionCode from it, so the installed version always matches the release
// line the build was cut from. Note what is NOT here, deliberately: this
// project has no expo-application dependency, so the Android versionCode
// is not exposed to JS at all (expo-constants in this SDK offers no
// nativeBuildVersion, and inventing one would be a lie). The comparison
// is therefore semver-vs-semver (see updater.ts header); if a future change
// adds expo-application, its nativeBuildVersion can be surfaced here for
// display, but it still cannot be compared against a GitHub tag, which
// carries no versionCode.
export const getInstalledVersion = (): { version: string } => ({
  version: Constants.expoConfig?.version ?? 'unknown',
});

/** Native installer surface (AirplaneInstallerModule, Android only). */
export interface InstallerModule {
  canInstallPackages: () => Promise<boolean>;
  openUnknownSourcesSettings: () => Promise<unknown>;
  downloadApk: (url: string, fileName: string) => Promise<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
  installApk: (path: string) => Promise<unknown>;
  deleteFile: (path: string) => Promise<unknown>;
}

type InstallerOverride = InstallerModule | null | undefined;
let installerOverride: InstallerOverride = undefined;

/** Test seam, following the updater's injectable-fetch pattern. */
export const setInstallerForTests = (installer: InstallerModule | null): void => {
  installerOverride = installer;
};

const getInstaller = (): InstallerModule | null => {
  if (installerOverride !== undefined) return installerOverride;
  const candidate = (NativeModules as Record<string, unknown>)
    .AirplaneInstaller as InstallerModule | undefined;
  if (!candidate) return null;
  const methods: (keyof InstallerModule)[] = [
    'canInstallPackages',
    'openUnknownSourcesSettings',
    'downloadApk',
    'installApk',
    'deleteFile',
  ];
  return methods.every((m) => typeof candidate[m] === 'function') ? candidate : null;
};

/** Outcome of one Download attempt, for callers and tests. */
export type DownloadStatus = 'installed' | 'browser' | 'failed' | 'permission';

export interface DownloadOptions {
  /** Fraction downloaded (0 to 1), or null when the size is unknown. */
  onDownloadProgress?: (fraction: number | null) => void;
  onDownloadEnd?: (status: DownloadStatus) => void;
}

// One prompt per release tag per app run, so the launch check does not
// nag on every foreground. A manual check from Settings always prompts.
const promptedTags = new Set<string>();

// A download parked while the user grants the install permission in system
// settings. Resumed when the app returns to foreground (see
// resumePendingUpdate); cleared on cancel, on any terminal outcome, and by
// resetUpdateCheckForTests.
let pendingUpdate: UpdateInfo | null = null;
let pendingDownloadOpts: DownloadOptions | undefined;
let resumeListenerRegistered = false;

/** For tests: clear prompts, pending downloads, and installer overrides. */
export const resetUpdateCheckForTests = (): void => {
  promptedTags.clear();
  pendingUpdate = null;
  pendingDownloadOpts = undefined;
  installerOverride = undefined;
};

type ProgressEvent = { received?: unknown; total?: unknown };

type EventSubscription = { remove: () => void };

const subscribeProgress = (
  installer: InstallerModule,
  cb: (fraction: number | null) => void,
): EventSubscription | null => {
  try {
    const Emitter = NativeEventEmitter as unknown as new (m: unknown) => {
      addListener: (event: string, listener: (e: ProgressEvent) => void) => EventSubscription;
    };
    const emitter = new Emitter(installer);
    return emitter.addListener('AirplaneInstallerDownloadProgress', (event) => {
      const received = event.received;
      const total = event.total;
      if (typeof received !== 'number') return;
      cb(typeof total === 'number' && total > 0 ? received / total : null);
    });
  } catch {
    return null;
  }
};

/** Browser fallback (pre-v0.1.21 behavior): open the URL, never crash. */
const openBrowserFallback = async (url: string, reason: string): Promise<DownloadStatus> => {
  const t = defaultTranslator().t;
  if (!isAllowedUpdateUrl(url, { downloadHost: true })) {
    recordUpdateEvent(`browser fallback failed ${reason}`);
    dialog.toast(t('settings.updateOpenFailed'));
    return 'failed';
  }
  try {
    const linking = Linking as unknown as
      | { openURL?: (u: string) => Promise<unknown> }
      | undefined;
    if (typeof linking?.openURL !== 'function') throw new Error('linking-unavailable');
    await linking.openURL(url);
    recordUpdateEvent(`browser fallback ${reason}`);
    return 'browser';
  } catch {
    recordUpdateEvent(`browser fallback failed ${reason}`);
    dialog.toast(t('settings.updateOpenFailed'));
    return 'failed';
  }
};

/** Classify a native download failure for the log line: the old bare
 *  `download-error` hid whether the network, a timeout, or the module
 *  itself failed. Unknown failures keep `download-error`. */
const classifyDownloadError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (
    /network|failed to fetch|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|offline|not reachable|network request failed/i.test(
      message,
    )
  ) {
    return 'network';
  }
  return 'download-error';
};

/**
 * Run one in-app download for an available update. Never throws: every
 * failure path toasts and returns a status. The permission gate runs
 * first; the hash gate runs before any install intent; a mismatch deletes
 * the file and never installs.
 */
export const startUpdateDownload = async (
  update: UpdateInfo,
  opts: DownloadOptions = {},
): Promise<DownloadStatus> => {
  const t = defaultTranslator().t;
  const downloadUrl = update.downloadUrl;
  if (downloadUrl === null || !isAllowedUpdateUrl(downloadUrl, { downloadHost: true })) {
    // No APK asset, or a URL outside the allowlist: the release page is
    // the only safe fallback.
    return openBrowserFallback(update.releaseUrl, 'no-apk');
  }
  const fileName = apkFileNameFromUrl(downloadUrl);
  if (fileName === null) return openBrowserFallback(update.releaseUrl, 'bad-filename');
  const installer = getInstaller();
  if (!installer) return openBrowserFallback(downloadUrl, 'no-installer');

  let allowed: boolean;
  try {
    allowed = await installer.canInstallPackages();
  } catch {
    recordUpdateEvent(`download failed can-install-check`);
    dialog.toast(t('settings.updateDownloadFailed'));
    opts.onDownloadEnd?.('failed');
    return 'failed';
  }
  if (!allowed) {
    pendingUpdate = update;
    pendingDownloadOpts = opts;
    recordUpdateEvent(`permission required ${update.version}`);
    ensureResumeListener();
    dialog.alert(t('settings.updatePermissionTitle'), t('settings.updatePermissionMessage'), [
      {
        text: t('settings.updateLater'),
        style: 'cancel',
        onPress: () => {
          pendingUpdate = null;
          pendingDownloadOpts = undefined;
        },
      },
      {
        text: t('settings.updatePermissionOpenSettings'),
        onPress: () => {
          void installer.openUnknownSourcesSettings().catch(() => {});
        },
      },
    ]);
    opts.onDownloadEnd?.('permission');
    return 'permission';
  }

  dialog.toast(t('settings.updateDownloading'));
  recordUpdateEvent(`download started ${update.version}`);
  // Progress milestones only (0, 25, 50, 75, 100): per-chunk fractions
  // would flood the log, but a download with no milestone at all must
  // still be visible as started-and-stalled, not silent.
  let lastMilestone = -1;
  const reportProgress = (fraction: number | null): void => {
    opts.onDownloadProgress?.(fraction);
    if (fraction === null) return;
    const milestone = fraction >= 1 ? 100 : Math.floor(fraction * 4) * 25;
    if (milestone > lastMilestone) {
      lastMilestone = milestone;
      recordUpdateEvent(`download progress ${milestone}`);
    }
  };
  reportProgress(0);
  const subscription = subscribeProgress(installer, reportProgress);
  let downloaded: { path: string; sha256: string; bytes: number };
  try {
    downloaded = await installer.downloadApk(downloadUrl, fileName);
  } catch (error: unknown) {
    subscription?.remove();
    recordUpdateEvent(`download failed ${classifyDownloadError(error)}`);
    dialog.toast(t('settings.updateDownloadFailed'));
    opts.onDownloadEnd?.('failed');
    return 'failed';
  }
  subscription?.remove();

  const sumsResult = await fetchSha256SumsDetailed(update.tag);
  for (const attempt of sumsResult.attempts) {
    recordUpdateEvent(
      `sums attempt ${attempt.attempt} ${attempt.source} ${attempt.ok ? 'ok' : `failed ${attempt.reason}`}`,
    );
  }
  const expected =
    sumsResult.sums === null ? null : expectedApkHash(sumsResult.sums, fileName);
  if (expected === null || expected.toLowerCase() !== downloaded.sha256.toLowerCase()) {
    await installer.deleteFile(downloaded.path).catch(() => {});
    recordUpdateEvent(
      `verify failed ${expected === null ? `no-sums ${sumsResult.lastReason}` : 'mismatch'}`,
    );
    dialog.toast(t('settings.updateVerifyFailed'));
    // Never a dead toast: verification failure used to strand the user
    // on the old version (v0.1.25 rollout, three no-sums failures, no
    // way forward inside the app). The release page is the safe
    // fallback here, not the APK URL: the APK just failed verification,
    // so routing the user straight to its download would bypass the
    // hash gate. The page lets them see the release and its hashes and
    // choose. The install intent path below keeps opening the APK URL
    // because there verification already passed.
    const fallbackStatus = await openBrowserFallback(update.releaseUrl, 'verify-failed');
    opts.onDownloadEnd?.(fallbackStatus);
    return fallbackStatus;
  }
  recordUpdateEvent(`verify ok ${update.version}`);

  try {
    await installer.installApk(downloaded.path);
  } catch {
    // Never a dead button: if the install intent cannot fire (for
    // example on a pre-Android 8 device, where the install intent action
    // does not resolve), fall back to the browser download instead of
    // leaving the user with a toast and no way forward.
    recordUpdateEvent(`install failed intent`);
    return openBrowserFallback(downloadUrl, 'install-intent-failed');
  }
  recordUpdateEvent(`install intent fired ${update.version}`);
  opts.onDownloadEnd?.('installed');
  return 'installed';
};

/**
 * Resume a download parked for the permission grant. Called when the app
 * returns to foreground; exported so tests can drive it without AppState.
 */
export const resumePendingUpdate = async (): Promise<void> => {
  const pending = pendingUpdate;
  if (!pending) return;
  pendingUpdate = null;
  const opts = pendingDownloadOpts;
  pendingDownloadOpts = undefined;
  const installer = getInstaller();
  if (!installer) {
    recordUpdateEvent(`download failed no-installer`);
    return;
  }
  let allowed = false;
  try {
    allowed = await installer.canInstallPackages();
  } catch {
    allowed = false;
  }
  if (!allowed) {
    recordUpdateEvent(`permission denied ${pending.version}`);
    dialog.toast(defaultTranslator().t('settings.updatePermissionDenied'));
    return;
  }
  await startUpdateDownload(pending, opts);
};

const ensureResumeListener = (): void => {
  if (resumeListenerRegistered) return;
  resumeListenerRegistered = true;
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void resumePendingUpdate();
  });
};

const promptForUpdate = (update: UpdateInfo, opts: DownloadOptions = {}): void => {
  const t = defaultTranslator().t;
  const downloadUrl = update.downloadUrl ?? update.releaseUrl;
  // Belt and braces on top of the updater allowlist: never open a URL
  // that fails it, even if an UpdateInfo was built by another path.
  if (!isAllowedUpdateUrl(downloadUrl, { downloadHost: true })) {
    dialog.toast(t('settings.updateOpenFailed'));
    return;
  }
  dialog.alert(
    t('settings.updateTitle', { version: update.version }),
    t('settings.updateMessage', { version: update.version }),
    [
      { text: t('settings.updateLater'), style: 'cancel' },
      {
        text: t('settings.updateDownload'),
        onPress: () => {
          void startUpdateDownload(update, opts);
        },
      },
    ],
  );
};

const runCheck = async (
  forcePrompt: boolean,
  opts: DownloadOptions = {},
): Promise<UpdateCheckResult> => {
  if (Platform.OS !== 'android') return { available: false, error: 'ios-unsupported' };
  const installed = getInstalledVersion().version;
  let result: UpdateCheckResult;
  try {
    result = await checkForUpdate({ currentVersion: installed });
  } catch {
    // checkForUpdate itself never throws; this is belt-and-braces so a
    // future refactor can never take launch down with it.
    recordUpdateEvent(`check failed check-failed`);
    return { available: false, error: 'check-failed' };
  }
  // The check outcome itself is a diagnostics line now: v0.1.22 logs
  // showed the settings:update-check taps with no result line at all,
  // so a silent check and a failed check were indistinguishable.
  if (result.available && result.update) {
    recordUpdateEvent(`check available ${result.update.version}`);
  } else if (result.error) {
    recordUpdateEvent(`check failed ${result.error}`);
  } else {
    recordUpdateEvent(`check up-to-date ${installed}`);
  }
  if (result.available && result.update && (forcePrompt || !promptedTags.has(result.update.tag))) {
    promptedTags.add(result.update.tag);
    promptForUpdate(result.update, opts);
  }
  return result;
};

/** Launch check: fire-and-forget from _layout after first paint. Never
 *  throws, never blocks, never prompts twice for the same release. */
export const checkForUpdateOnLaunch = (): Promise<UpdateCheckResult> => runCheck(false);

/** Manual check from Settings: always prompts when an update is available.
 *  Callers may pass download callbacks to show downloading state. */
export const checkForUpdateFromSettings = (
  opts: DownloadOptions = {},
): Promise<UpdateCheckResult> => runCheck(true, opts);
