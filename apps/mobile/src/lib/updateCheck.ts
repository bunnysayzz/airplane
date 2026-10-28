// SPDX-License-Identifier: Apache-2.0
// T14 — UI wiring for the GitHub-Releases update check (Android only).
//
// Launch safety is the whole point: every path here swallows errors, so a
// failed check, no network, or a bad response can never break launch. The
// prompt is advisory only — "Later" dismisses it, nothing installs silently
// and nothing is ever force-installed.
//
// iOS: this module is a no-op on iOS. A sideloaded iOS app cannot install
// itself (no install intent, no App Store path for this build), so no iOS
// updater is built; the Settings row is hidden on iOS (see settings.tsx).
//
// Install-intent status, stated honestly: the "Download" button opens the
// APK URL with Linking, so the system browser/downloader fetches it and the
// user taps the downloaded file to install — the standard sideload flow.
// That is NOT an in-app ACTION_INSTALL_PACKAGE intent. The remaining step
// is a download-to-cache + FileProvider + ACTION_INSTALL_PACKAGE wiring
// (with the REQUEST_INSTALL_PACKAGES grant flow), which cannot be verified
// without a device build and is therefore NOT faked here. The permission
// itself is declared in app.json and AndroidManifest.xml as the preparatory
// half; declaring it alone installs nothing.

import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';
import {
  checkForUpdate,
  isAllowedUpdateUrl,
  type UpdateCheckResult,
  type UpdateInfo,
} from '../../services/airplane/updater';
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

// One prompt per release tag per app run, so the launch check does not
// nag on every foreground. A manual check from Settings always prompts.
const promptedTags = new Set<string>();

const promptForUpdate = (update: UpdateInfo): void => {
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
          Linking.openURL(downloadUrl).catch(() => {
            dialog.toast(t('settings.updateOpenFailed'));
          });
        },
      },
    ],
  );
};

const runCheck = async (forcePrompt: boolean): Promise<UpdateCheckResult> => {
  if (Platform.OS !== 'android') return { available: false, error: 'ios-unsupported' };
  let result: UpdateCheckResult;
  try {
    result = await checkForUpdate({ currentVersion: getInstalledVersion().version });
  } catch {
    // checkForUpdate itself never throws; this is belt-and-braces so a
    // future refactor can never take launch down with it.
    return { available: false, error: 'check-failed' };
  }
  if (result.available && result.update && (forcePrompt || !promptedTags.has(result.update.tag))) {
    promptedTags.add(result.update.tag);
    promptForUpdate(result.update);
  }
  return result;
};

/** Launch check: fire-and-forget from _layout after first paint. Never
 *  throws, never blocks, never prompts twice for the same release. */
export const checkForUpdateOnLaunch = (): Promise<UpdateCheckResult> => runCheck(false);

/** Manual check from Settings: always prompts when an update is available. */
export const checkForUpdateFromSettings = (): Promise<UpdateCheckResult> => runCheck(true);
