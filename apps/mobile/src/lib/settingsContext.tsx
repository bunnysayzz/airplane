import React, { createContext, useContext, useState, useEffect } from 'react';
import { getSetting, saveSetting } from './storage';
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
    /** Effective relay list: the custom list, or DEFAULT_RELAYS when uncustomized. */
    relays: string[];
    /** True once the user has saved any custom list (including an empty one). */
    relaysCustomized: boolean;
    /** Add a relay; false when the URL is invalid or already listed. Persists on success. */
    addRelay: (url: string) => Promise<boolean>;
    /** Remove a relay. Persists. */
    removeRelay: (url: string) => Promise<void>;
    /** Forget the custom list and restore the defaults. Persists. */
    resetRelays: () => Promise<void>;
    loadingSettings: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const COMPACT_KEY = 'airplane_settings_compact';

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [compactMode, setCompactModeState] = useState(false);
    const [relays, setRelaysState] = useState<string[]>([...DEFAULT_RELAYS]);
    const [relaysCustomized, setRelaysCustomized] = useState(false);
    const [loadingSettings, setLoadingSettings] = useState(true);

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const compact = await getSetting(COMPACT_KEY, false);
                setCompactModeState(compact);
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
        setCompactModeState(value);
        await saveSetting(COMPACT_KEY, value);
    };

    // The transport reads the same persisted list at launch (see
    // services/airplane/transport.ts); a relay change therefore applies on
    // the next app start, not mid-session — the Nostr client is built with
    // its relay list at construction and is never torn down live.
    const addRelay = async (url: string): Promise<boolean> => {
        const next = addRelayUrl(relays, url);
        if (next === null) return false;
        setRelaysState(next);
        setRelaysCustomized(true);
        await saveRelayUrls(next);
        return true;
    };

    const removeRelay = async (url: string) => {
        const next = removeRelayUrl(relays, url);
        setRelaysState(next);
        setRelaysCustomized(true);
        await saveRelayUrls(next);
    };

    const resetRelays = async () => {
        setRelaysState([...DEFAULT_RELAYS]);
        setRelaysCustomized(false);
        await resetRelayUrls();
    };

    return (
        <SettingsContext.Provider
            value={{
                compactMode,
                setCompactMode,
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
