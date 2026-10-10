import { StyleSheet } from 'react-native';
import { ThemeColors } from '../../src/theme/themeContext';
import { TAB_BAR_CLEARANCE } from '../../components/TabBar/styles';
import { radii, space } from '../../src/theme/shape';

export const FEED_PILL_HEIGHT = 34;

export const makeStyles = (colors: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    loadingContainer: {
        flex: 1,
        backgroundColor: colors.background,
        justifyContent: 'center',
        alignItems: 'center',
    },
    feedPicker: {
        flexDirection: 'row',
        gap: space.sm,
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 10,
    },
    list: {
        flex: 1,
    },
    // The "N new posts" pill floats over the top of the list
    newPostsWrap: {
        position: 'absolute',
        top: space.sm,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 10,
    },
    newPosts: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: 6,
        paddingHorizontal: 14,
        borderRadius: radii.pill,
        backgroundColor: colors.accentColor,
        shadowColor: colors.shadowColor,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.18,
        shadowRadius: 10,
        elevation: 6,
    },
    newPostsText: {
        color: colors.buttonTextColor,
    },
    footer: {
        paddingVertical: 20,
        alignItems: 'center',
    },
    listContent: {
        paddingTop: 8,
        paddingBottom: TAB_BAR_CLEARANCE,
    },
    emptyContainer: {
        flex: 1,
        marginTop: 100,
        padding: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        color: colors.textSecondary,
        fontSize: 16,
        textAlign: 'center',
    },
    errorContainer: {
        flex: 1,
        backgroundColor: colors.background,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.md,
        padding: 40,
    },
    errorText: {
        color: colors.textSecondary,
        textAlign: 'center',
    },
    retryButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: radii.pill,
        backgroundColor: colors.accentColor,
    },
    retryText: {
        color: colors.buttonTextColor,
        fontSize: 14,
    },
    feedPill: {
        height: FEED_PILL_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        borderRadius: radii.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.borderColor,
        backgroundColor: colors.cardBackground,
    },
    feedPillActive: {
        backgroundColor: colors.accentColor,
        borderColor: colors.accentColor,
    },
    feedPillText: {
        fontSize: 13.5,
        color: colors.textSecondary,
    },
    feedPillTextActive: {
        color: colors.buttonTextColor,
    },
});
