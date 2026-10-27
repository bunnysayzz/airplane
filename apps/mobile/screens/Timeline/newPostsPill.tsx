import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { makeStyles } from './styles';

interface NewPostsPillProps {
    label: string;
    hint: string;
    loading: boolean;
    onPress: () => void;
}

// Floats over the top of the list when newer posts are waiting; tapping loads them and scrolls up.
// (Pugdon's version showed the new posts' avatars; Airplane is anonymous, so it's just the count.)
export const NewPostsPill: React.FC<NewPostsPillProps> = ({ label, hint, loading, onPress }) => {
    const { colors, type } = useTheme();
    const styles = useThemedStyles(makeStyles);

    return (
        <View style={styles.newPostsWrap} pointerEvents="box-none">
            <Pressable
                onPress={onPress}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={hint}
                accessibilityState={{ busy: loading }}
                style={({ pressed }) => [styles.newPosts, pressed && { opacity: 0.85 }]}
            >
                {loading ? (
                    <ActivityIndicator size="small" color={colors.buttonTextColor} />
                ) : (
                    <Ionicons name="arrow-up" size={16} color={colors.buttonTextColor} />
                )}
                <Text style={[type.name, styles.newPostsText]}>{label}</Text>
            </Pressable>
        </View>
    );
};
