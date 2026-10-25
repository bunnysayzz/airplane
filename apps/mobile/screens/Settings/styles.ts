import { StyleSheet } from 'react-native';
import { ThemeColors } from '../../src/theme/themeContext';
import { radii, space } from '../../src/theme/shape';

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    contentContainer: {
      paddingHorizontal: space.lg,
      paddingTop: space.xs,
      // Bottom clearance tracks the floating dock - applied by the screen
      // (it needs the live safe-area inset). The dock floats over Settings.
      gap: space.sm,
    },
    sectionLabel: {
      marginTop: space.md,
      marginHorizontal: space.xs,
    },
    group: {
      overflow: 'hidden',
    },
    row: {
      minHeight: 54,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingVertical: 10,
      paddingHorizontal: space.lg,
    },
    rowCentered: {
      justifyContent: 'center',
    },
    rowText: {
      flex: 1,
    },
    rowLabel: {
      color: colors.textPrimary,
    },
    rowValue: {
      color: colors.textSecondary,
    },
    rowTrailing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.borderColor,
      marginHorizontal: space.lg,
    },
    // In-app privacy explainer (reuses the onboarding privacy card; works offline)
    privacyLead: {
      color: colors.textSecondary,
      marginTop: space.md,
      marginHorizontal: space.xs,
    },
    privacyCard: {
      padding: space.xl,
    },
    fullPolicyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.xs,
      paddingVertical: space.md,
    },
    fullPolicyText: {
      color: colors.accentText,
    },
  });

export const makeAppearanceStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    content: {
      paddingHorizontal: space.lg,
      paddingTop: space.xs,
      // Bottom clearance tracks the floating dock - applied by the screen
      // (it needs the live safe-area inset). The dock floats over Settings.
      gap: space.sm,
    },
    sectionLabel: {
      marginTop: space.md,
      marginHorizontal: space.xs,
    },
    coatHeader: {
      marginTop: space.md,
      marginHorizontal: space.xs,
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    coatHint: {
      color: colors.textMuted,
    },
    preview: {
      paddingTop: space.md,
      paddingHorizontal: space.lg,
      paddingBottom: space.sm,
      gap: space.sm,
    },
    previewAuthor: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
    },
    previewNames: {
      flex: 1,
    },
    previewName: {
      color: colors.textPrimary,
    },
    previewHandle: {
      color: colors.textMuted,
    },
    previewBody: {
      color: colors.textPrimary,
    },
    previewTag: {
      color: colors.accentText,
    },
    pollBar: {
      height: 36,
      borderRadius: radii.input,
      overflow: 'hidden',
      backgroundColor: colors.inputBackground,
      justifyContent: 'center',
    },
    pollFill: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: '64%',
      backgroundColor: colors.accentColor,
    },
    pollLabels: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: space.md,
    },
    pollOption: {
      color: colors.buttonTextColor,
    },
    pollPercent: {
      color: colors.textPrimary,
    },
    previewActions: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingRight: space.xl,
    },
    previewAction: {
      height: 32,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
    },
    previewCount: {
      color: colors.textMuted,
    },
    previewCountActive: {
      color: colors.accentText,
    },
    coatGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: space.sm,
    },
    coat: {
      flexBasis: '30%',
      flexGrow: 1,
      height: 80,
      borderRadius: radii.well,
      borderWidth: 1,
      borderColor: colors.borderColor,
      backgroundColor: colors.cardBackground,
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.xs,
    },
    coatSelected: {
      borderWidth: 2,
      borderColor: colors.accentText,
      backgroundColor: colors.accentSoft,
    },
    coatName: {
      color: colors.textPrimary,
    },
    tintRow: {
      marginTop: space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingVertical: space.md,
      paddingHorizontal: space.lg,
    },
    tintText: {
      flex: 1,
      gap: space.xs,
    },
    tintLabel: {
      color: colors.textPrimary,
    },
    tintDetail: {
      color: colors.textMuted,
    },
  });

export const makeRelayStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    content: {
      paddingHorizontal: space.lg,
      paddingTop: space.xs,
      gap: space.sm,
    },
    sectionLabel: {
      marginTop: space.md,
      marginHorizontal: space.xs,
    },
    lead: {
      color: colors.textSecondary,
      marginTop: space.md,
      marginHorizontal: space.xs,
    },
    restartNote: {
      color: colors.textMuted,
      marginHorizontal: space.xs,
    },
    group: {
      overflow: 'hidden',
    },
    row: {
      minHeight: 54,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingVertical: 10,
      paddingHorizontal: space.lg,
    },
    rowText: {
      flex: 1,
      color: colors.textPrimary,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.borderColor,
      marginHorizontal: space.lg,
    },
    empty: {
      color: colors.textMuted,
      padding: space.lg,
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      padding: space.md,
    },
    input: {
      flex: 1,
      color: colors.textPrimary,
      backgroundColor: colors.inputBackground,
      borderRadius: radii.input,
      paddingHorizontal: space.md,
      paddingVertical: space.md,
    },
    addButton: {
      backgroundColor: colors.accentColor,
      borderRadius: radii.input,
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
    },
    addButtonDisabled: {
      opacity: 0.5,
    },
    addButtonText: {
      color: colors.buttonTextColor,
    },
    error: {
      color: colors.dangerColor,
      paddingHorizontal: space.lg,
      paddingBottom: space.md,
    },
    resetRow: {
      alignItems: 'center',
      paddingVertical: space.md,
    },
    resetText: {
      color: colors.accentText,
    },
  });
