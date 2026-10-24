import React, { useEffect, useRef } from 'react';
import { Linking, Platform } from 'react-native';
import { dialog } from '../../src/lib/dialog';
import { useI18n } from '../../src/i18n/i18nContext';
import { getSetting, saveSetting } from '../../src/lib/storage';
import { getBleRadioState, enableBleRadio } from '../../services/airplane/transport';

// One-time BLE permission priming, owned by track prod-14.
//
// The OS Bluetooth dialog never fires at app boot (transport startup only
// *checks* the grants). When the radio is permission-blocked and the user
// hasn't answered yet, this shows the app's own rationale first and fires
// the real OS request only on "Enable Bluetooth" — the user's explicit
// action. Denied -> clear copy + a one-tap path to Settings. The answer is
// persisted, so the user is never nagged again; granting later in OS
// Settings is picked up automatically by the startup check on next launch.
const BLE_PRIMING_ANSWERED_KEY = 'airplane_ble_priming_answered';

// How long to wait for the transport's startup permission check before
// giving up (the check usually finished long before the feed mounts).
const STARTUP_WAIT_MS = 10_000;
const STARTUP_POLL_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const BlePrime: React.FC = () => {
    const { t } = useI18n();
    const ran = useRef(false);

    useEffect(() => {
        if (ran.current) return;
        ran.current = true;
        // BLE runtime permissions are Android-only; the radio never starts
        // elsewhere (permissions.ts returns false off-Android).
        if (Platform.OS !== 'android') return;
        void (async () => {
            if (await getSetting(BLE_PRIMING_ANSWERED_KEY, false)) return;
            const deadline = Date.now() + STARTUP_WAIT_MS;
            while (getBleRadioState() === 'starting' && Date.now() < deadline) {
                await sleep(STARTUP_POLL_MS);
            }
            if (getBleRadioState() !== 'permission-blocked') return;
            const enable = await new Promise<boolean>((resolve) => {
                dialog.alert(t('ble.primeTitle'), t('ble.primeMessage'), [
                    {
                        text: t('ble.notNow'),
                        style: 'cancel',
                        onPress: () => resolve(false),
                    },
                    { text: t('ble.enable'), onPress: () => resolve(true) },
                ]);
            });
            // Any explicit answer ends priming: no repeated nagging.
            await saveSetting(BLE_PRIMING_ANSWERED_KEY, true);
            if (!enable) return;
            if (await enableBleRadio()) {
                dialog.toast(t('ble.enabled'));
            } else {
                dialog.alert(t('ble.deniedTitle'), t('ble.deniedMessage'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('common.settings'),
                        onPress: () => Linking.openSettings(),
                    },
                ]);
            }
        })();
    }, [t]);

    return null;
};
