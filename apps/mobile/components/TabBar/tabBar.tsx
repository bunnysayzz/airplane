import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme/themeContext';
import { makeStyles, dockBottomOffset } from './styles';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { recordUiEvent } from '../../services/airplane/diagnostics';

export type TabIconName = React.ComponentProps<typeof Ionicons>['name'];

export interface TabDef {
    key: string;
    label: string;
    icon: TabIconName;
    activeIcon: TabIconName;
    // Unread message count for the tab, Twitter style: a number pill,
    // not a dot. Zero or absent means no pill.
    badgeCount?: number;
}

/** Pill text for a count: exact up to 99, then 99+ like Twitter. */
export function unreadPillText(count: number): string {
    return count > 99 ? '99+' : String(count);
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
        const count = def.badgeCount ?? 0;
        // The open tab already shows them
        const showCount = count > 0 && !active;
        return (
            <Pressable
                key={def.key}
                onPress={() => {
                    recordUiEvent(`tab:${def.key}`);
                    onTabPress(def.key);
                }}
                accessibilityRole="tab"
                accessibilityLabel={count > 0 ? `${def.label}, ${count} unread` : def.label}
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [styles.tab, active && styles.tabActive, pressed && { opacity: 0.7 }]}
            >
                <View>
                    <Ionicons name={active ? def.activeIcon : def.icon} size={24} color={active ? colors.accentText : colors.textMuted} />
                    {showCount && (
                        <View testID="unread-count" style={styles.countPill}>
                            <Text style={styles.countPillText}>{unreadPillText(count)}</Text>
                        </View>
                    )}
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
                    onPress={() => {
                        recordUiEvent('compose:open');
                        onComposePress();
                    }}
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
