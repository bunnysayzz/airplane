import { StyleSheet } from 'react-native';
import { ThemeColors } from '../../src/theme/themeContext';
import { radii, space } from '../../src/theme/shape';

// Trimmed from pugdon's ComposeModal styles: Airplane v1 composes text only
// (no attachments, polls, emoji picker, visibility or language sheets).
export const makeStyles = (colors: ThemeColors) => StyleSheet.create({
    root: {
        flex: 1,
    },
    keyboardAvoider: {
        flex: 1,
    },
    sheet: {
        flex: 1,
        borderTopLeftRadius: radii.sheet,
        borderTopRightRadius: radii.sheet,
        backgroundColor: colors.cardBackground,
        shadowColor: colors.shadowColor,
        shadowOffset: { width: 0, height: -8 },
        shadowOpacity: 0.12,
        shadowRadius: 30,
        elevation: 12,
    },
    grabberRow: {
        alignItems: 'center',
        paddingTop: space.sm,
    },
    grabber: {
        width: 38,
        height: 5,
        borderRadius: radii.pill,
        backgroundColor: colors.borderColor,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: space.sm,
        paddingHorizontal: space.lg,
    },
    // Keeps the title centered whatever the button widths
    headerSide: {
        flex: 1,
        flexDirection: 'row',
    },
    headerSideEnd: {
        justifyContent: 'flex-end',
    },
    // The sides share what the title leaves, so titles stay short (one line) to leave room for the buttons
    headerTitle: {
        color: colors.textPrimary,
    },
    cancel: {
        paddingHorizontal: 6,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        paddingTop: space.lg,
        paddingBottom: space.xl,
        gap: 14,
    },
    textArea: {
        minHeight: 120,
        paddingHorizontal: 20,
        paddingVertical: 0,
        color: colors.textPrimary,
        textAlignVertical: 'top',
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingTop: 10,
        paddingHorizontal: space.md,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.borderColor,
    },
    toolbarSpacer: {
        flex: 1,
    },
    counter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingRight: space.xs,
    },
    counterText: {
        fontSize: 13,
    },
});
