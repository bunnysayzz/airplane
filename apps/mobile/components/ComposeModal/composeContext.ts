import { createContext } from 'react';

/**
 * Provided by the tabs layout; opens the compose sheet from anywhere inside
 * the tab tree (e.g. the feed's empty state). Defaults to a no-op so screens
 * also render in tests without a provider.
 */
export const ComposeOpenContext = createContext<() => void>(() => {});
