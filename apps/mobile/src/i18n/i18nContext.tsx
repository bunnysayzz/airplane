import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getStringSetting, saveStringSetting } from '../lib/storage';
import { DEFAULT_LANGUAGE, Language, LANGUAGES } from './defaults';
import { createTranslator, Translator } from './translate';

export const LANGUAGE_KEY = 'airplane_settings_language';

interface I18nContextType extends Translator {
    setLanguage: (language: Language) => Promise<void>;
    // The saved language has been read (the splash stays up until then, so there's no flash of the default)
    languageReady: boolean;
}

const fallback: I18nContextType = {
    ...createTranslator(DEFAULT_LANGUAGE),
    setLanguage: async () => {},
    languageReady: true,
};

const I18nContext = createContext<I18nContextType>(fallback);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);
    const [languageReady, setLanguageReady] = useState(false);

    useEffect(() => {
        getStringSetting(LANGUAGE_KEY, DEFAULT_LANGUAGE)
            .then(saved => {
                if ((LANGUAGES as string[]).includes(saved)) setLanguageState(saved as Language);
            })
            .catch(() => {})
            .finally(() => setLanguageReady(true));
    }, []);

    const value = useMemo<I18nContextType>(
        () => ({
            ...createTranslator(language),
            languageReady,
            setLanguage: async (next: Language) => {
                setLanguageState(next);
                await saveStringSetting(LANGUAGE_KEY, next);
            },
        }),
        [language, languageReady]
    );

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

// Works without a provider too (component tests): then it's the default language
export const useI18n = () => useContext(I18nContext);
