import React, { createContext, useContext, useState, useEffect } from 'react';
import { getSetting, saveSetting } from './storage';
import {
  startForegroundRelay,
  stopForegroundRelay,
} from '../../services/airplane/foregroundService';
import {
    DEFAULT_RELAYS,
    addRelayUrl,
    loadStoredRelays,
    removeRelayUrl,
    resetRelayUrls,
    saveRelayUrls,
} from './relays';

// Trimmed from pugdon's settingsContext: Airplane has no accounts, notifications or
// media autoplay, so only the generic list-density preference survives.
interface SettingsContextType {
    compactMode: boolean;
    setCompactMode: (value: boolean) => Promise<void>;
    /** T4: background-relay preference (default OFF). False on iOS and on
     * builds without the native service: the toggle reports failure
     * instead of pretending the service started. */
    foregroundRelayEnabled: boolean;
    /** Persist first, then start/stop the service; returns false when
     * the service could not start, in which case the toggle stays off. */
    setForegroundRelayEnabled: (value: boolean) => Promise<boolean>;
    /** Effective relay list: the custom list, or DEFAULT_RELAYS when uncustomized. */
    relays: string[];
    /** True once the user has saved any custom list (including an empty one). */
    relaysCustomized: boolean;
    /** Add a relay; false when the URL is invalid, already listed, or the save failed. Persists first. */
    addRelay: (url: string) => Promise<boolean>;
    /** Remove a relay; false when the save failed. Persists first. */
    removeRelay: (url: string) => Promise<boolean>;
    /** Forget the custom list and restore the defaults; false when the save failed. Persists first. */
    resetRelays: () => Promise<boolean>;
    loadingSettings: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const COMPACT_KEY = 'airplane_settings_compact';
export const FOREGROUND_RELAY_KEY = 'airplane_settings_foreground_relay';

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [compactMode, setCompactModeState] = useState(false);
    const [foregroundRelayEnabled, setForegroundRelayEnabledState] = useState(false);
    const [relays, setRelaysState] = useState<string[]>([...DEFAULT_RELAYS]);
    const [relaysCustomized, setRelaysCustomized] = useState(false);
    const [loadingSettings, setLoadingSettings] = useState(true);

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const compact = await getSetting(COMPACT_KEY, false);
                setCompactModeState(compact);
                // T4 restore: a saved ON preference re-starts the service
                // on launch (a foreground service does not survive a
                // process kill by design: START_NOT_STICKY, see the
                // Kotlin service). A failed restore leaves the toggle
                // off rather than claiming a running service.
                const relayOn = await getSetting(FOREGROUND_RELAY_KEY, false);
                if (relayOn) {
                    const started = await startForegroundRelay().catch(() => false);
                    setForegroundRelayEnabledState(started);
                    if (!started) {
                        await saveSetting(FOREGROUND_RELAY_KEY, false).catch(() => {});
                    }
                }
                const stored = await loadStoredRelays();
                if (stored !== null) {
                    setRelaysState(stored);
                    setRelaysCustomized(true);
                }
            } catch (error) {
                console.error('Failed to load settings:', error);
            } finally {
                setLoadingSettings(false);
            }
        };
        loadSettings();
    }, []);

    const setCompactMode = async (value: boolean) => {
        // Persist first, then set UI state: a failed save leaves the
        // switch on its old value instead of diverging from disk.
        try {
            await saveSetting(COMPACT_KEY, value);
        } catch {
            return;
        }
        setCompactModeState(value);
    };

    const setForegroundRelayEnabled = async (value: boolean): Promise<boolean> => {
        try {
            await saveSetting(FOREGROUND_RELAY_KEY, value);
        } catch {
            return false;
        }
        if (value) {
            const started = await startForegroundRelay().catch(() => false);
            setForegroundRelayEnabledState(started);
            if (!started) {
                // The toggle must not claim ON for a service that is
                // not running (iOS, Expo Go, missing native module).
                await saveSetting(FOREGROUND_RELAY_KEY, false).catch(() => {});
            }
            return started;
        }
        await stopForegroundRelay().catch(() => {});
        setForegroundRelayEnabledState(false);
        return true;
    };

    // The transport reads the same persisted list at launch (see
    // services/airplane/transport.ts); a relay change therefore applies on
    // the next app start, not mid-session — the Nostr client is built with
    // its relay list at construction and is never torn down live.
    // Every mutation below persists FIRST and only then updates UI
    // state, so a save failure leaves UI and disk in agreement (and
    // returns false so the screen can show an error instead of
    // clearing the draft and reporting success).
    const addRelay = async (url: string): Promise<boolean> => {
        const next = addRelayUrl(relays, url);
        if (next === null) return false;
        try {
            await saveRelayUrls(next);
        } catch {
            return false;
        }
        setRelaysState(next);
        setRelaysCustomized(true);
        return true;
    };

    const removeRelay = async (url: string): Promise<boolean> => {
        const next = removeRelayUrl(relays, url);
        try {
            await saveRelayUrls(next);
        } catch {
            return false;
        }
        setRelaysState(next);
        setRelaysCustomized(true);
        return true;
    };

    const resetRelays = async (): Promise<boolean> => {
        try {
            await resetRelayUrls();
        } catch {
            return false;
        }
        setRelaysState([...DEFAULT_RELAYS]);
        setRelaysCustomized(false);
        return true;
    };

    return (
        <SettingsContext.Provider
            value={{
                compactMode,
                setCompactMode,
                foregroundRelayEnabled,
                setForegroundRelayEnabled,
                relays,
                relaysCustomized,
                addRelay,
                removeRelay,
                resetRelays,
                loadingSettings,
            }}
        >
            {children}
        </SettingsContext.Provider>
    );
};

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error('useSettings must be used within a SettingsProvider');
    }
    return context;
};
