import { StyleSheet } from 'react-native';
import { ThemeColors } from '../../src/theme/themeContext';
import { space } from '../../src/theme/shape';

export const HEADER_HEIGHT = 52;

export const makeStyles = (colors: ThemeColors) => StyleSheet.create({
    safeArea: {
        backgroundColor: colors.background,
    },
    container: {
        height: HEADER_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: space.lg,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.borderColor,
        backgroundColor: colors.background,
    },
    wordmark: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    wordmarkText: {
        fontSize: 22,
        lineHeight: 28,
        color: colors.textPrimary,
    },
    settingsButton: {
        marginRight: -space.sm,
    },
    rightCluster: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
});
