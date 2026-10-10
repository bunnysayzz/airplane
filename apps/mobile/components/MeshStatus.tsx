import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMeshStatus, type RelayState } from '../src/lib/useMeshStatus';
import { useTheme, type ThemeColors } from '../src/theme/themeContext';
import { useThemedStyles } from '../src/theme/useThemedStyles';
import { useI18n } from '../src/i18n/i18nContext';
import { radii, space } from '../src/theme/shape';

const RELAY_ICON: Record<RelayState, React.ComponentProps<typeof Ionicons>['name']> = {
    mesh: 'radio-outline',
    online: 'cloud-outline',
    offline: 'cloud-offline-outline',
};

// A small status pill for the top bar: peers seen on the mesh plus relay state.
// Pugdon's pill language (hairline border, soft fill, meta type). The numbers are
// honest - peersNearby stays 0 until useMeshStatus is wired to the real transport (P3).
export const MeshStatus: React.FC = () => {
    const { colors, type } = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { t, tn } = useI18n();
    const { peersNearby, relayState } = useMeshStatus();

    const live = relayState !== 'offline';
    const relayLabel = relayState === 'online' ? t('meshStatus.online') : relayState === 'mesh' ? t('meshStatus.meshOnly') : t('meshStatus.offline');
    const peersLabel = tn('meshStatus.nearby', peersNearby);

    return (
        <View
            style={styles.pill}
            accessible
            accessibilityRole="text"
            accessibilityLabel={t('meshStatus.a11y', { peers: peersLabel, status: relayLabel })}
        >
            <View style={[styles.dot, { backgroundColor: live ? colors.accentColor : colors.textMuted }]} />
            <Text style={[type.meta, styles.peers]} numberOfLines={1}>
                {peersLabel}
            </Text>
            <Ionicons name={RELAY_ICON[relayState]} size={13} color={colors.textSecondary} />
            <Text style={[type.meta, styles.status]} numberOfLines={1}>
                {relayLabel}
            </Text>
        </View>
    );
};

const makeStyles = (colors: ThemeColors) =>
    StyleSheet.create({
        pill: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: radii.pill,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.borderColor,
            backgroundColor: colors.cardBackground,
        },
        dot: {
            width: 7,
            height: 7,
            borderRadius: 4,
        },
        peers: {
            color: colors.textSecondary,
        },
        status: {
            color: colors.textMuted,
        },
    });
