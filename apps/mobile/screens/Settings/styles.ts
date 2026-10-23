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
      paddingTop: 6,
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
      fontSize: 15,
      color: colors.textPrimary,
    },
    rowDetail: {
      fontSize: 12.5,
      color: colors.textMuted,
    },
    rowValue: {
      fontSize: 14,
      color: colors.textSecondary,
    },
    rowTrailing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
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
      paddingTop: 6,
      // Bottom clearance tracks the floating dock - applied by the screen
      // (it needs the live safe-area inset). The dock floats over Settings.
      gap: space.sm,
    },
    sectionLabel: {
      marginTop: 10,
      marginHorizontal: space.xs,
    },
    coatHeader: {
      marginTop: 10,
      marginHorizontal: space.xs,
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    coatHint: {
      color: colors.textMuted,
    },
    preview: {
      paddingTop: 14,
      paddingHorizontal: space.lg,
      paddingBottom: space.sm,
      gap: 10,
    },
    previewAuthor: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    previewNames: {
      flex: 1,
    },
    previewName: {
      fontSize: 14.5,
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
      borderRadius: 10,
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
      fontSize: 13.5,
      color: colors.buttonTextColor,
    },
    pollPercent: {
      fontSize: 13.5,
      color: colors.textPrimary,
    },
    previewActions: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingRight: 32,
    },
    previewAction: {
      height: 32,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
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
      gap: 6,
    },
    coatSelected: {
      borderWidth: 2,
      borderColor: colors.accentText,
      backgroundColor: colors.accentSoft,
    },
    coatName: {
      fontSize: 13,
      color: colors.textPrimary,
    },
    tintRow: {
      marginTop: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingVertical: space.md,
      paddingHorizontal: space.lg,
    },
    tintText: {
      flex: 1,
      gap: 2,
    },
    tintLabel: {
      color: colors.textPrimary,
    },
    tintDetail: {
      color: colors.textMuted,
    },
  });
