import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../src/theme/themeContext';

interface AvatarProps {
    // Used for the initials fallback and the accessibility label
    name: string;
    uri?: string | null;
    size?: number;
    // Type glyph in an accent circle at the bottom-right (e.g. a notification's type)
    badge?: React.ComponentProps<typeof Ionicons>['name'];
    ring?: boolean;
}

export const initialsOf = (name: string) =>
    name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(word => Array.from(word)[0] ?? '')
        .join('')
        .toUpperCase() || '?';

const BADGE_SIZE = 22;

// Type glyph in an accent circle, pinned to the bottom-right of the avatar (or avatar stack) it sits in
export const AvatarBadge: React.FC<{ icon: React.ComponentProps<typeof Ionicons>['name'] }> = ({ icon }) => {
    const { colors } = useTheme();
    return (
        <View testID="avatar-badge" style={[styles.badge, { backgroundColor: colors.accentColor, borderColor: colors.cardBackground }]}>
            <Ionicons name={icon} size={12} color={colors.buttonTextColor} />
        </View>
    );
};

export const Avatar: React.FC<AvatarProps> = ({ name, uri, size = 42, badge, ring = false }) => {
    const { colors, type } = useTheme();
    const [failedUri, setFailedUri] = useState<string | null>(null);
    const showImage = !!uri && uri !== failedUri;
    const circle = { width: size, height: size, borderRadius: size / 2 };

    return (
        <View accessible accessibilityRole="image" accessibilityLabel={name} style={circle}>
            {showImage ? (
                <Image testID="avatar-image" source={{ uri }} style={[circle, { backgroundColor: colors.inputBackground }]} onError={() => setFailedUri(uri)} />
            ) : (
                <View style={[circle, styles.initials, { backgroundColor: colors.accentSoft }]}>
                    <Text style={[type.name, { fontSize: size * 0.38, lineHeight: size * 0.5, color: colors.accentText }]}>
                        {initialsOf(name)}
                    </Text>
                </View>
            )}
            {ring && <View pointerEvents="none" style={[StyleSheet.absoluteFill, circle, styles.ring, { borderColor: colors.accentColor }]} />}
            {badge && <AvatarBadge icon={badge} />}
        </View>
    );
};

const styles = StyleSheet.create({
    initials: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    ring: {
        borderWidth: 2,
    },
    badge: {
        position: 'absolute',
        right: -4,
        bottom: -4,
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        borderRadius: BADGE_SIZE / 2,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
