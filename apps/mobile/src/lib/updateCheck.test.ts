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
  return { ...actual, fetchSha256Sums: jest.fn() };
});

import * as RN from 'react-native';
import { NativeEventEmitter } from 'react-native';
import { fetchSha256Sums, type UpdateInfo } from '../../services/airplane/updater';
import { dialog } from './dialog';
import {
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

const makeInstaller = (overrides: Partial<InstallerModule> = {}): InstallerModule & {
  [K in keyof InstallerModule]: jest.Mock;
} =>
  ({
    canInstallPackages: jest.fn(async () => true),
    openUnknownSourcesSettings: jest.fn(async () => true),
    downloadApk: jest.fn(async () => ({ path: APK_PATH, sha256: GOOD_HASH, bytes: 123 })),
    installApk: jest.fn(async () => true),
    deleteFile: jest.fn(async () => true),
    ...overrides,
  }) as never;

const mockedFetchSums = () => fetchSha256Sums as unknown as jest.Mock;
const mockedAlert = () => dialog.alert as unknown as jest.Mock;
const mockedToast = () => dialog.toast as unknown as jest.Mock;

const alertButtons = () => {
  const calls = mockedAlert().mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][2] as Array<{ text: string; onPress?: () => void }>;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetUpdateCheckForTests();
  mockedFetchSums().mockReset();
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
    mockedFetchSums().mockResolvedValue(sumsWith(GOOD_HASH));
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
    const status = await startUpdateDownload(update);
    expect(status).toBe('browser');
    expect(openURL).toHaveBeenCalledWith(update.downloadUrl);
  });
});

describe('hash gate', () => {
  test('matching hash installs', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedFetchSums().mockResolvedValue(sumsWith(GOOD_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('installed');
    expect(installer.installApk).toHaveBeenCalledWith(APK_PATH);
    expect(installer.deleteFile).not.toHaveBeenCalled();
  });

  test('mismatching hash deletes the file and never installs', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedFetchSums().mockResolvedValue(sumsWith(OTHER_HASH));
    const status = await startUpdateDownload(update);
    expect(status).toBe('failed');
    expect(installer.deleteFile).toHaveBeenCalledWith(APK_PATH);
    expect(installer.installApk).not.toHaveBeenCalled();
    expect(mockedToast()).toHaveBeenCalledWith('settings.updateVerifyFailed');
  });

  test('missing sums file aborts without installing', async () => {
    const installer = makeInstaller();
    setInstallerForTests(installer);
    mockedFetchSums().mockResolvedValue(null);
    const status = await startUpdateDownload(update);
    expect(status).toBe('failed');
    expect(installer.deleteFile).toHaveBeenCalledWith(APK_PATH);
    expect(installer.installApk).not.toHaveBeenCalled();
  });

  test('download failure never reaches install', async () => {
    const installer = makeInstaller({
      downloadApk: jest.fn(async () => {
        throw new Error('network down');
      }),
    });
    setInstallerForTests(installer);
    const status = await startUpdateDownload(update);
    expect(status).toBe('failed');
    expect(installer.installApk).not.toHaveBeenCalled();
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
    mockedFetchSums().mockResolvedValue(sumsWith(GOOD_HASH));
    const openURL = jest.fn(async () => {});
    (RN as unknown as Record<string, unknown>).Linking = { openURL };
    const status = await startUpdateDownload(update);
    expect(status).toBe('browser');
    expect(openURL).toHaveBeenCalledWith(update.downloadUrl);
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
    mockedFetchSums().mockResolvedValue(sumsWith(GOOD_HASH));
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
