import { useMemo } from 'react';
import { ThemeColors, useTheme } from './themeContext';

// Builds a component's StyleSheet from the current theme colors, once per theme change.
// Pass a module-level factory (e.g. `makeStyles` from ./styles) so the memo stays stable.
export function useThemedStyles<T>(makeStyles: (colors: ThemeColors) => T): T {
    const { colors } = useTheme();
    return useMemo(() => makeStyles(colors), [makeStyles, colors]);
}
