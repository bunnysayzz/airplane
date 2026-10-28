import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { useFonts } from 'expo-font';
import { getSetting, getStringSetting, saveSetting, saveStringSetting } from '../lib/storage';
import { buildColors, CoatKey, DEFAULT_COAT, isCoatKey, ThemeColors } from './coats';
import { buildType, fontAssets, TypeScale } from './typography';

export type ThemeType = 'light' | 'dark' | 'system';

export type { ThemeColors, CoatKey } from './coats';
export type { TypeScale } from './typography';

interface ThemeContextType {
    theme: ThemeType;
    setTheme: (theme: ThemeType) => Promise<void>;
    coat: CoatKey;
    setCoat: (coat: CoatKey) => Promise<void>;
    // Whether the coat's hue tints the neutrals (ground, surface, lines, ink)
    tint: boolean;
    setTint: (tint: boolean) => Promise<void>;
    colors: ThemeColors;
    type: TypeScale;
    // Fonts finished loading, or failed and the type scale fell back to the system font
    fontsReady: boolean;
    isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_KEY = 'airplane_settings_theme';
const COAT_KEY = 'airplane_settings_coat';
const TINT_KEY = 'airplane_settings_tint';

export const lightColors: ThemeColors = buildColors(DEFAULT_COAT, false, true);
export const darkColors: ThemeColors = buildColors(DEFAULT_COAT, true, true);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [theme, setThemeState] = useState<ThemeType>('system');
    const [coat, setCoatState] = useState<CoatKey>(DEFAULT_COAT);
    const [tint, setTintState] = useState(true);
    const systemColorScheme = useColorScheme();
    const [fontsLoaded, fontError] = useFonts(fontAssets);

    useEffect(() => {
        const loadTheme = async () => {
            try {
                const [storedTheme, storedCoat, storedTint] = await Promise.all([
                    getStringSetting(THEME_KEY, 'system'),
                    getStringSetting(COAT_KEY, DEFAULT_COAT),
                    getSetting(TINT_KEY, true),
                ]);
                setThemeState(storedTheme as ThemeType);
                setCoatState(isCoatKey(storedCoat) ? storedCoat : DEFAULT_COAT);
                setTintState(storedTint);
            } catch (error) {
                console.error('Failed to load theme:', error);
            }
        };
        loadTheme();
    }, []);

    useEffect(() => {
        if (fontError) {
            console.warn('Failed to load fonts, using the system font:', fontError);
        }
    }, [fontError]);

    const setTheme = async (newTheme: ThemeType) => {
        setThemeState(newTheme);
        await saveStringSetting(THEME_KEY, newTheme);
    };

    const setCoat = async (newCoat: CoatKey) => {
        setCoatState(newCoat);
        await saveStringSetting(COAT_KEY, newCoat);
    };

    const setTint = async (newTint: boolean) => {
        setTintState(newTint);
        await saveSetting(TINT_KEY, newTint);
    };

    const isDark = theme === 'system' ? systemColorScheme === 'dark' : theme === 'dark';
    const colors = useMemo(() => buildColors(coat, isDark, tint), [coat, isDark, tint]);
    const type = useMemo(() => buildType(fontsLoaded), [fontsLoaded]);
    const fontsReady = fontsLoaded || !!fontError;

    return (
        <ThemeContext.Provider value={{ theme, setTheme, coat, setCoat, tint, setTint, colors, type, fontsReady, isDark }}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
