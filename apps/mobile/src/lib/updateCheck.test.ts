// SPDX-License-Identifier: Apache-2.0
// T14 tests: permission gate plus resume, native-missing browser fallback,
// hash mismatch abort, progress callbacks, sums failure abort. The native
// module itself cannot run in jest; every test drives a fake installer
// through the same seam the updater uses for injectable fetch.

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.20' } },
}));
jest.mock('../i18n/translate', () => ({
  defaultTranslator: () => ({ t: (key: string) => key }),
}));
jest.mock('./dialog', () => ({
  dialog: { alert: jest.fn(), toast: jest.fn() },
}));
jest.mock('../../services/airplane/updater', () => {
  const actual = jest.requireActual('../../services/airplane/updater');
  return { ...actual, fetchSha256SumsDetailed: jest.fn(), checkForUpdate: jest.fn() };
});
jest.mock('../../services/airplane/diagnostics', () => ({
  recordUpdateEvent: jest.fn(),
}));

import * as RN from 'react-native';
import { NativeEventEmitter, Platform } from 'react-native';
import {
  checkForUpdate,
  fetchSha256SumsDetailed,
  type UpdateInfo,
} from '../../services/airplane/updater';
import { recordUpdateEvent } from '../../services/airplane/diagnostics';
import { dialog } from './dialog';
import {
  checkForUpdateOnLaunch,
  resetUpdateCheckForTests,
  resumePendingUpdate,
  setInstallerForTests,
  startUpdateDownload,
  type DownloadOptions,
  type InstallerModule,
} from './updateCheck';

const update: UpdateInfo = {
  version: '0.1.21',
  tag: 'v0.1.21',
  downloadUrl:
    'https://github.com/bunnysayzz/airplane/releases/download/v0.1.21/airplane-v0.1.21.apk',
  releaseUrl: 'https://github.com/bunnysayzz/airplane/releases/tag/v0.1.21',
};

const APK_PATH = '/cache/updates/airplane-v0.1.21.apk';
const GOOD_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

const sumsWith = (hash: string) =>
  new Map<string, string>([['airplane-v0.1.21.apk', hash]]);

/** Detailed sums result shape, as startUpdateDownload consumes it. */
const detailedSums = (hash: string | null, reason = 'ok') => ({
  sums: hash === null ? null : sumsWith(hash),
  attempts: [
    {
      source: 'download' as const,
      attempt: 1,
      ok: hash !== null,
      reason: hash === null ? reason : 'ok',
    },
  ],
  lastReason: hash === null ? reason : 'ok',
});

const makeInstaller = (overrides: Partial<InstallerModule> = {}): InstallerModule & {
  [K in keyof InstallerModule]: jest.Mock;
} =>
  ({
    canInstallPackages: jest.fn(async () => true),
    openUnknownSourcesSettings: jest.fn(async () => true),
    downloadApk: jest.fn(async () => ({ path: APK_PATH, sha256: GOOD_HASH, bytes: 123 })),
    installApk: jest.fn(async () => true),
    deleteFile: jest.fn(async () => true),
    // No cached APK by default: the restart-resume path is skipped and
    // the download runs fresh, as on a build without hashCachedApk.
    hashCachedApk: jest.fn(async () => null),
    ...overrides,
  }) as never;

const mockedDetailedSums = () => fetchSha256SumsDetailed as unknown as jest.Mock;
const mockedCheckForUpdate = () => checkForUpdate as unknown as jest.Mock;
const mockedRecordEvent = () => recordUpdateEvent as unknown as jest.Mock;
const mockedAlert = () => dialog.alert as unknown as jest.Mock;
const mockedToast = () => dialog.toast as unknown as jest.Mock;

const alertButtons = () => {
  const calls = mockedAlert().mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][2] as Array<{ text: string; onPress?: () => void }>;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const emitterInstances = () =>
  (NativeEventEmitter as unknown as {
    instances: Array<{ emit: (event: string, payload: unknown) => void }>;
  }).instances;

beforeEach(() => {
  resetUpdateCheckForTests();
  mockedDetailedSums().mockReset();
  mockedCheckForUpdate().mockReset();
  mockedRecordEvent().mockClear();
  mockedAlert().mockClear();
  mockedToast().mockClear();
});

afterEach(() => {
  delete (RN as unknown as Record<string, unknown>).Linking;
});

describe('permission gate', () => {
  test('denied grant parks the download and opens settings, resume installs', async () => {
    const installer = makeInstaller({ canInstallPackages: jest.fn(async () => false) });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const ends: string[] = [];
    const opts: DownloadOptions = { onDownloadEnd: (status) => ends.push(status) };
    const status = await startUpdateDownload(update, opts);
    expect(status).toBe('permission');
    expect(ends).toEqual(['permission']);
    const buttons = alertButtons();
    expect(buttons.some((b) => b.text === 'settings.updatePermissionOpenSettings')).toBe(true);
    const openSettings = buttons.find((b) => b.text === 'settings.updatePermissionOpenSettings');
    expect(openSettings?.onPress).toBeDefined();
    openSettings?.onPress?.();
    expect(installer.openUnknownSourcesSettings).toHaveBeenCalled();
    expect(installer.downloadApk).not.toHaveBeenCalled();

    installer.canInstallPackages = jest.fn(async () => true);
    await resumePendingUpdate();
    expect(installer.downloadApk).toHaveBeenCalledWith(
      update.downloadUrl,
      'airplane-v0.1.21.apk',
    );
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
    expect(ends).toEqual(['permission', 'installed']);
  });

  test('cancel clears the parked download so resume does nothing', async () => {
    const installer = makeInstaller({ canInstallPackages: jest.fn(async () => false) });
    setInstallerForTests(installer);
    await startUpdateDownload(update);
    const buttons = alertButtons();
    const cancel = buttons.find((b) => b.text === 'settings.updateLater');
    expect(cancel?.onPress).toBeDefined();
    cancel?.onPress?.();
    await resumePendingUpdate();
    expect(installer.downloadApk).not.toHaveBeenCalled();
    expect(installer.installApk).not.toHaveBeenCalled();
  });

  test('still-denied grant on resume toasts and does not download', async () => {
    const installer = makeInstaller({ canInstallPackages: jest.fn(async () => false) });
    setInstallerForTests(installer);
    await startUpdateDownload(update);
    await resumePendingUpdate();
    expect(installer.downloadApk).not.toHaveBeenCalled();
    expect(mockedToast()).toHaveBeenCalledWith('settings.updatePermissionDenied');
  });
});

describe('native-missing fallback', () => {
  test('no installer opens the APK URL in the browser', async () => {
    setInstallerForTests(null);
    const openURL = jest.fn(async () => {});
    (RN as unknown as Record<string, unknown>).Linking = { openURL };
    const ends: string[] = [];
    const status = await startUpdateDownload(update, {
      onDownloadEnd: (end) => ends.push(end),
    });
    expect(status).toBe('browser');
    expect(openURL).toHaveBeenCalledWith(update.downloadUrl);
    // v0.1.34: every terminal path ends the download, so the Settings
    // row cannot sit on "downloading" after a fallback.
    expect(ends).toEqual(['browser']);
  });
});

describe('hash gate', () => {
  test('matching hash installs', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('installed');
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
    expect(installer.deleteFile).not.toHaveBeenCalled();
  });

  test('mismatching hash deletes the file, never installs, opens the release page', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(OTHER_HASH));
    const openURL = jest.fn(async () => {});
    (RN as unknown as Record<string, unknown>).Linking = { openURL };
    const status = await startUpdateDownload(update);
    expect(status).toBe('browser');
    expect(installer.deleteFile).toHaveBeenCalledWith(APK_PATH);
    expect(installer.installApk).not.toHaveBeenCalled();
    expect(mockedToast()).toHaveBeenCalledWith('settings.updateVerifyFailed');
    // The release page, not the APK URL: the APK just failed
    // verification, so routing to its download would bypass the gate.
    expect(openURL).toHaveBeenCalledWith(update.releaseUrl);
    expect(mockedRecordEvent()).toHaveBeenCalledWith('verify failed mismatch');
  });

  test('missing sums file aborts without installing, with the fetch reason on the line', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(null, 'http-404'));
    const openURL = jest.fn(async () => {});
    (RN as unknown as Record<string, unknown>).Linking = { openURL };
    const status = await startUpdateDownload(update);
    expect(status).toBe('browser');
    // v0.1.34 sums-first: no download starts when the sums file is
    // unavailable, so there is no just-downloaded file to delete.
    expect(installer.downloadApk).not.toHaveBeenCalled();
    expect(installer.deleteFile).not.toHaveBeenCalled();
    expect(installer.installApk).not.toHaveBeenCalled();
    expect(openURL).toHaveBeenCalledWith(update.releaseUrl);
    expect(mockedRecordEvent()).toHaveBeenCalledWith('verify failed no-sums http-404');
    expect(mockedRecordEvent()).toHaveBeenCalledWith('sums attempt 1 download failed http-404');
  });

  test('verify failure with no browser to open ends failed, not stuck', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(null, 'http-404'));
    (RN as unknown as Record<string, unknown>).Linking = {};
    const status = await startUpdateDownload(update);
    expect(status).toBe('failed');
    // v0.1.34 sums-first: no download starts, so no file to delete.
    expect(installer.downloadApk).not.toHaveBeenCalled();
    expect(installer.deleteFile).not.toHaveBeenCalled();
    expect(installer.installApk).not.toHaveBeenCalled();
    expect(mockedToast()).toHaveBeenCalledWith('settings.updateOpenFailed');
  });

  test('download failure never reaches install', async () => {
    const installer = makeInstaller({
      downloadApk: jest.fn(async () => {
        throw new Error('network down');
      }),
    });
    setInstallerForTests(installer);
    // v0.1.34 sums-first: the sums fetch runs before the download, so
    // it must be configured or the flow dies at the sums step instead
    // of at the download this test is about.
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('failed');
    expect(installer.downloadApk).toHaveBeenCalled();
    expect(installer.installApk).not.toHaveBeenCalled();
    expect(mockedRecordEvent()).toHaveBeenCalledWith('download failed network');
    expect(mockedToast()).toHaveBeenCalledWith('settings.updateDownloadFailed');
  });
});

describe('install intent failure', () => {
  test('a rejected install intent falls back to the browser, never a dead button', async () => {
    const installer = makeInstaller({
      installApk: jest.fn(async () => {
        throw new Error('no activity');
      }),
    });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const openURL = jest.fn(async () => {});
    (RN as unknown as Record<string, unknown>).Linking = { openURL };
    const ends: string[] = [];
    const status = await startUpdateDownload(update, {
      onDownloadEnd: (end) => ends.push(end),
    });
    expect(status).toBe('browser');
    expect(openURL).toHaveBeenCalledWith(update.downloadUrl);
    // v0.1.34: the install-intent failure path used to skip the
    // download-end callback (the v0.1.26 nit), leaving the Settings row
    // on "downloading" until the next check.
    expect(ends).toEqual(['browser']);
  });
});

describe('progress callbacks', () => {
  test('emitted progress reaches the callback as a fraction', async () => {
    let resolveDownload!: (value: { path: string; sha256: string; bytes: number }) => void;
    const downloadPromise = new Promise<{ path: string; sha256: string; bytes: number }>(
      (resolve) => {
        resolveDownload = resolve;
      },
    );
    const installer = makeInstaller({ downloadApk: jest.fn(() => downloadPromise) });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const fractions: Array<number | null> = [];
    const pending = startUpdateDownload(update, {
      onDownloadProgress: (fraction) => fractions.push(fraction),
    });
    await flush();
    await flush();
    expect(installer.downloadApk).toHaveBeenCalled();
    const Emitter = NativeEventEmitter as unknown as {
      instances: Array<{ emit: (event: string, payload: unknown) => void }>;
    };
    expect(Emitter.instances.length).toBeGreaterThan(0);
    Emitter.instances[Emitter.instances.length - 1].emit('AirplaneInstallerDownloadProgress', {
      received: 50,
      total: 100,
    });
    expect(fractions).toContain(0.5);
    resolveDownload({ path: APK_PATH, sha256: GOOD_HASH, bytes: 100 });
    await expect(pending).resolves.toBe('installed');
  });
});

describe('launch check', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    (Platform as unknown as { OS: string }).OS = 'android';
  });

  afterEach(() => {
    (Platform as unknown as { OS: string }).OS = originalOs;
  });

  const pressDownload = async () => {
    const buttons = alertButtons();
    const download = buttons.find((b) => b.text === 'settings.updateDownload');
    expect(download?.onPress).toBeDefined();
    download?.onPress?.();
    await flush();
    await flush();
    await flush();
  };

  test('launch check prompts once per tag and accepting runs the full flow', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    mockedCheckForUpdate().mockResolvedValue({ available: true, update });
    await checkForUpdateOnLaunch();
    expect(mockedAlert()).toHaveBeenCalledWith(
      'settings.updateTitle',
      expect.anything(),
      expect.anything(),
    );
    await pressDownload();
    expect(installer.downloadApk).toHaveBeenCalledWith(
      update.downloadUrl,
      'airplane-v0.1.21.apk',
    );
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
  });

  test('a second launch check for the same tag does not re-prompt', async () => {
    setInstallerForTests(makeInstaller());
    mockedCheckForUpdate().mockResolvedValue({ available: true, update });
    await checkForUpdateOnLaunch();
    await checkForUpdateOnLaunch();
    expect(mockedAlert()).toHaveBeenCalledTimes(1);
  });

  test('no available update prompts nothing on launch', async () => {
    mockedCheckForUpdate().mockResolvedValue({ available: false });
    await checkForUpdateOnLaunch();
    expect(mockedAlert()).not.toHaveBeenCalled();
  });
});

describe('single-flight (v0.1.34)', () => {
  const controllableDownload = () => {
    let resolveDownload!: (value: { path: string; sha256: string; bytes: number }) => void;
    const downloadPromise = new Promise<{ path: string; sha256: string; bytes: number }>(
      (resolve) => {
        resolveDownload = resolve;
      },
    );
    return { downloadPromise, resolveDownload };
  };

  test('two concurrent starts coalesce to one download and one listener', async () => {
    const { downloadPromise, resolveDownload } = controllableDownload();
    const installer = makeInstaller({ downloadApk: jest.fn(() => downloadPromise) });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const fractions1: Array<number | null> = [];
    const fractions2: Array<number | null> = [];
    const ends1: string[] = [];
    const ends2: string[] = [];
    const before = emitterInstances().length;
    const first = startUpdateDownload(update, {
      onDownloadProgress: (fraction) => fractions1.push(fraction),
      onDownloadEnd: (status) => ends1.push(status),
    });
    await flush();
    await flush();
    expect(installer.downloadApk).toHaveBeenCalledTimes(1);
    const second = startUpdateDownload(update, {
      onDownloadProgress: (fraction) => fractions2.push(fraction),
      onDownloadEnd: (status) => ends2.push(status),
    });
    // Same promise: the second caller joins the in-flight download.
    expect(second).toBe(first);
    expect(installer.downloadApk).toHaveBeenCalledTimes(1);
    expect(emitterInstances().length - before).toBe(1);
    expect(mockedRecordEvent()).toHaveBeenCalledWith('download coalesced 0.1.21');
    emitterInstances()[emitterInstances().length - 1].emit(
      'AirplaneInstallerDownloadProgress',
      { received: 50, total: 100 },
    );
    expect(fractions1).toContain(0.5);
    expect(fractions2).toContain(0.5);
    resolveDownload({ path: APK_PATH, sha256: GOOD_HASH, bytes: 100 });
    await expect(first).resolves.toBe('installed');
    await expect(second).resolves.toBe('installed');
    expect(ends1).toEqual(['installed']);
    expect(ends2).toEqual(['installed']);
  });

  test('a second start for a different version joins the in-flight download', async () => {
    const { downloadPromise, resolveDownload } = controllableDownload();
    const installer = makeInstaller({ downloadApk: jest.fn(() => downloadPromise) });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const first = startUpdateDownload(update);
    await flush();
    await flush();
    const newer: UpdateInfo = {
      version: '0.1.22',
      tag: 'v0.1.22',
      downloadUrl:
        'https://github.com/bunnysayzz/airplane/releases/download/v0.1.22/airplane-v0.1.22.apk',
      releaseUrl: 'https://github.com/bunnysayzz/airplane/releases/tag/v0.1.22',
    };
    const second = startUpdateDownload(newer);
    expect(second).toBe(first);
    expect(installer.downloadApk).toHaveBeenCalledTimes(1);
    expect(mockedRecordEvent()).toHaveBeenCalledWith('download coalesced 0.1.21');
    resolveDownload({ path: APK_PATH, sha256: GOOD_HASH, bytes: 100 });
    await expect(first).resolves.toBe('installed');
    await expect(second).resolves.toBe('installed');
  });
});

describe('download watchdogs (v0.1.34)', () => {
  const controllableDownload = () => {
    let resolveDownload!: (value: { path: string; sha256: string; bytes: number }) => void;
    const downloadPromise = new Promise<{ path: string; sha256: string; bytes: number }>(
      (resolve) => {
        resolveDownload = resolve;
      },
    );
    return { downloadPromise, resolveDownload };
  };

  test('a download with no progress for the stall window fails visibly', async () => {
    const { downloadPromise, resolveDownload } = controllableDownload();
    const installer = makeInstaller({ downloadApk: jest.fn(() => downloadPromise) });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const ends: string[] = [];
    const pending = startUpdateDownload(update, {
      stallTimeoutMs: 30,
      settleTimeoutMs: 10_000,
      onDownloadEnd: (status) => ends.push(status),
    });
    await expect(pending).resolves.toBe('failed');
    expect(mockedRecordEvent()).toHaveBeenCalledWith('download stalled 0.1.21 at 0%');
    expect(mockedToast()).toHaveBeenCalledWith('settings.updateDownloadFailed');
    expect(ends).toEqual(['failed']);
    expect(installer.installApk).not.toHaveBeenCalled();
    // A late native resolution is ignored: no second end, no install.
    resolveDownload({ path: APK_PATH, sha256: GOOD_HASH, bytes: 100 });
    await flush();
    await flush();
    expect(ends).toEqual(['failed']);
    expect(installer.installApk).not.toHaveBeenCalled();
  });

  test('100% progress with no settlement fails visibly', async () => {
    const { downloadPromise, resolveDownload } = controllableDownload();
    const installer = makeInstaller({ downloadApk: jest.fn(() => downloadPromise) });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const ends: string[] = [];
    const pending = startUpdateDownload(update, {
      stallTimeoutMs: 10_000,
      settleTimeoutMs: 30,
      onDownloadEnd: (status) => ends.push(status),
    });
    await flush();
    await flush();
    emitterInstances()[emitterInstances().length - 1].emit(
      'AirplaneInstallerDownloadProgress',
      { received: 100, total: 100 },
    );
    await expect(pending).resolves.toBe('failed');
    expect(mockedRecordEvent()).toHaveBeenCalledWith('download stuck after 100% 0.1.21');
    expect(mockedToast()).toHaveBeenCalledWith('settings.updateDownloadFailed');
    expect(ends).toEqual(['failed']);
    expect(installer.installApk).not.toHaveBeenCalled();
    resolveDownload({ path: APK_PATH, sha256: GOOD_HASH, bytes: 100 });
    await flush();
    await flush();
    expect(ends).toEqual(['failed']);
    expect(installer.installApk).not.toHaveBeenCalled();
  });
});

describe('restart resume (v0.1.34)', () => {
  test('a cached APK whose hash matches installs without re-downloading', async () => {
    const installer = makeInstaller({
      hashCachedApk: jest.fn(async () => ({ path: APK_PATH, sha256: GOOD_HASH, bytes: 123 })),
    });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('installed');
    expect(installer.downloadApk).not.toHaveBeenCalled();
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
    expect(mockedRecordEvent()).toHaveBeenCalledWith('verify ok 0.1.21 (cached)');
  });

  test('a cached APK whose hash mismatches is discarded and the download runs fresh', async () => {
    const installer = makeInstaller({
      hashCachedApk: jest.fn(async () => ({ path: APK_PATH, sha256: OTHER_HASH, bytes: 123 })),
    });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('installed');
    expect(mockedRecordEvent()).toHaveBeenCalledWith('cached apk discarded 0.1.21');
    expect(installer.deleteFile).toHaveBeenCalledWith(APK_PATH);
    expect(installer.downloadApk).toHaveBeenCalled();
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
  });

  test('a throwing hashCachedApk falls back to a fresh download', async () => {
    const installer = makeInstaller({
      hashCachedApk: jest.fn(async () => {
        throw new Error('nope');
      }),
    });
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('installed');
    expect(installer.downloadApk).toHaveBeenCalled();
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
  });

  test('a missing hashCachedApk method downloads fresh', async () => {
    const installer = makeInstaller();
    delete (installer as unknown as Record<string, unknown>).hashCachedApk;
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('installed');
    expect(installer.downloadApk).toHaveBeenCalled();
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
  });
});

describe('progress listener removal (v0.1.34)', () => {
  test('a throwing progress-listener remove does not skip verification', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedDetailedSums().mockResolvedValue(detailedSums(GOOD_HASH));
    const Emitter = NativeEventEmitter as unknown as {
      prototype: { addListener: (...args: unknown[]) => unknown };
    };
    const spy = jest.spyOn(Emitter.prototype, 'addListener').mockImplementation(() => ({
      remove: () => {
        throw new Error('remove boom');
      },
    }));
    try {
      const status = await startUpdateDownload(update);
      expect(status).toBe('installed');
      expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
      expect(mockedRecordEvent()).toHaveBeenCalledWith('download listener remove failed 0.1.21');
    } finally {
      spy.mockRestore();
    }
  });
});
