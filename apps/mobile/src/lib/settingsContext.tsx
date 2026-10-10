import React, { createContext, useContext, useState, useEffect } from 'react';
import { getSetting, saveSetting } from './storage';

// Trimmed from pugdon's settingsContext: Airplane has no accounts, notifications or
// media autoplay, so only the generic list-density preference survives.
interface SettingsContextType {
    compactMode: boolean;
    setCompactMode: (value: boolean) => Promise<void>;
    loadingSettings: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const COMPACT_KEY = 'airplane_settings_compact';

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [compactMode, setCompactModeState] = useState(false);
    const [loadingSettings, setLoadingSettings] = useState(true);

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const compact = await getSetting(COMPACT_KEY, false);
                setCompactModeState(compact);
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

    return (
        <SettingsContext.Provider
            value={{
                compactMode,
                setCompactMode,
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
