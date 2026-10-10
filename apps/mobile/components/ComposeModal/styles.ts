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
    // Kept mounted but out of the way
    hidden: {
        display: 'none',
    },
    textArea: {
        minHeight: 120,
        paddingHorizontal: 20,
        paddingVertical: 0,
        color: colors.textPrimary,
        fontSize: 17,
        lineHeight: 24.5,
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
    // The opt-in World uplink: off means the post stays on the local mesh only
    uplinkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        marginHorizontal: space.lg,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radii.well,
        backgroundColor: colors.accentSoft,
    },
    uplinkText: {
        flex: 1,
        gap: 2,
    },
    uplinkLabel: {
        color: colors.textPrimary,
    },
    uplinkDetail: {
        color: colors.textSecondary,
    },

    /* Bottom sheets */
    sheetRoot: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheetBackdrop: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: colors.scrim,
    },
    pickerSheet: {
        maxHeight: '75%',
        paddingHorizontal: space.lg,
        borderTopLeftRadius: radii.sheet,
        borderTopRightRadius: radii.sheet,
        backgroundColor: colors.cardBackground,
    },
    pickerTitle: {
        color: colors.textPrimary,
        paddingTop: space.md,
        paddingBottom: space.sm,
        paddingHorizontal: space.xs,
    },
    pickerTitleWithSubtitle: {
        paddingBottom: 2,
    },
    pickerSubtitle: {
        color: colors.textMuted,
        paddingBottom: space.sm,
        paddingHorizontal: space.xs,
    },
    option: {
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: space.md,
        borderRadius: radii.input,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
    },
    optionSelected: {
        backgroundColor: colors.accentSoft,
    },
    optionText: {
        flex: 1,
        gap: 1,
    },
    optionLabel: {
        color: colors.textPrimary,
    },
    optionDescription: {
        color: colors.textMuted,
    },
});
