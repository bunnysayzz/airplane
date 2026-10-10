import { StyleSheet, Platform } from 'react-native';
import { ThemeColors } from '../../src/theme/themeContext';

export const DOCK_HEIGHT = 68;
export const DOCK_BOTTOM_OFFSET = Platform.OS === 'ios' ? 28 : 20;

// Bottom padding for scrollable tab screens so their last item can scroll above the floating dock
export const TAB_BAR_CLEARANCE = DOCK_HEIGHT + DOCK_BOTTOM_OFFSET + 16;

export const makeStyles = (colors: ThemeColors) => StyleSheet.create({
    // Unread notifications: a coat-coloured dot on the bell's shoulder, ringed so it reads on the glass
    dot: {
        position: 'absolute',
        top: -1,
        right: -2,
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: colors.accentColor,
        borderWidth: 1.5,
        borderColor: colors.cardBackground,
    },
    dockWrapper: {
        position: 'absolute',
        bottom: DOCK_BOTTOM_OFFSET,
        left: 16,
        right: 16,
        height: DOCK_HEIGHT,
        borderRadius: DOCK_HEIGHT / 2,
        zIndex: 100, // Make sure it sits above the feed
        // The shadow lives on the wrapper: the blur below clips its own overflow
        shadowColor: colors.shadowColor,
        shadowOffset: { width: 0, height: 12 },
        shadowRadius: 16,
        elevation: 8,
    },
    dock: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        borderRadius: DOCK_HEIGHT / 2,
        borderWidth: 1,
        borderColor: colors.borderColor,
        backgroundColor: colors.tabBarBackground,
        overflow: 'hidden',
    },
    tab: {
        width: 56,
        height: 44,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabActive: {
        backgroundColor: colors.accentSoft,
    },
    compose: {
        width: 52,
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.accentColor,
    },
});
