import { StyleSheet } from 'react-native';
import { ThemeColors } from '../../src/theme/themeContext';
import { radii, space } from '../../src/theme/shape';

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.xl,
      backgroundColor: colors.background,
    },
    title: {
      marginTop: space.lg,
      color: colors.textPrimary,
      textAlign: 'center',
    },
    server: {
      marginTop: space.xs,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    message: {
      marginTop: space.xl,
      minHeight: 22,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    track: {
      alignSelf: 'stretch',
      height: 6,
      marginTop: space.md,
      borderRadius: radii.pill,
      overflow: 'hidden',
      backgroundColor: colors.inputBackground,
    },
    fill: {
      height: '100%',
      borderRadius: radii.pill,
      backgroundColor: colors.accentColor,
    },
    skip: {
      marginTop: space.xl,
    },
    // Explainer phase: the pages scroll full-bleed, content stays padded
    explainerContainer: {
      paddingHorizontal: 0,
    },
    pager: {
      flex: 1,
      alignSelf: 'stretch',
    },
    page: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: space.xl,
    },
    dots: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: space.sm,
      marginTop: space.lg,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: radii.pill,
      backgroundColor: colors.textMuted,
      opacity: 0.4,
    },
    dotActive: {
      backgroundColor: colors.accentColor,
      opacity: 1,
    },
    primary: {
      marginTop: space.lg,
      paddingHorizontal: space.xl * 2,
      alignSelf: 'center',
    },
  });

export const makeCardStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      alignItems: 'center',
    },
    iconCircle: {
      width: 88,
      height: 88,
      borderRadius: radii.pill,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: space.xl,
    },
    title: {
      color: colors.textPrimary,
      textAlign: 'center',
      marginBottom: space.md,
    },
    body: {
      color: colors.textPrimary,
      textAlign: 'center',
      marginBottom: space.md,
    },
    note: {
      color: colors.textMuted,
      textAlign: 'center',
      marginTop: space.xs,
    },
  });
