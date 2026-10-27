import React from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme/themeContext';
import { makeStyles, dockBottomOffset } from './styles';
import { useThemedStyles } from '../../src/theme/useThemedStyles';

export type TabIconName = React.ComponentProps<typeof Ionicons>['name'];

export interface TabDef {
    key: string;
    label: string;
    icon: TabIconName;
    activeIcon: TabIconName;
    // A dot on the tab for unseen activity
    badge?: boolean;
}

interface TabBarProps {
    tabs: TabDef[];
    activeTab: string;
    onTabPress: (key: string) => void;
    onComposePress: () => void;
    composeLabel: string;
}

// Pugdon's floating glass dock: outline icon when idle, filled when active, with a
// central compose button. The tabs themselves are driven by props so the app's
// navigation (expo-router, another worker) decides what they are.
export const TabBar: React.FC<TabBarProps> = ({ tabs, activeTab, onTabPress, onComposePress, composeLabel }) => {
    const { colors, isDark } = useTheme();
    const styles = useThemedStyles(makeStyles);
    const insets = useSafeAreaInsets();

    const tab = (def: TabDef) => {
        const active = def.key === activeTab;
        // The open tab already shows them
        const dot = def.badge && !active;
        return (
            <Pressable
                key={def.key}
                onPress={() => onTabPress(def.key)}
                accessibilityRole="tab"
                accessibilityLabel={def.label}
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [styles.tab, active && styles.tabActive, pressed && { opacity: 0.7 }]}
            >
                <View>
                    <Ionicons name={active ? def.activeIcon : def.icon} size={24} color={active ? colors.accentText : colors.textMuted} />
                    {dot && <View testID="unread-dot" style={styles.dot} />}
                </View>
            </Pressable>
        );
    };

    // The compose button sits in the middle of the tab row
    const middle = Math.floor(tabs.length / 2);

    return (
        <View
            style={[styles.dockWrapper, { bottom: dockBottomOffset(insets.bottom), shadowOpacity: isDark ? 0.5 : 0.14 }]}
            pointerEvents="box-none"
        >
            <BlurView intensity={isDark ? 30 : 60} tint={isDark ? 'dark' : 'light'} style={styles.dock} accessibilityRole="tablist">
                {tabs.slice(0, middle).map(tab)}
                <Pressable
                    onPress={onComposePress}
                    accessibilityRole="button"
                    accessibilityLabel={composeLabel}
                    style={({ pressed }) => [styles.compose, pressed && { opacity: 0.85 }]}
                >
                    <Ionicons name="add" size={28} color={colors.buttonTextColor} />
                </Pressable>
                {tabs.slice(middle).map(tab)}
            </BlurView>
        </View>
    );
};
