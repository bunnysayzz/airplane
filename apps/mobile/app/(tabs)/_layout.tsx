import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { TabBar, type TabDef } from '../../components/TabBar/tabBar';
import ComposeModal from '../../components/ComposeModal/composeModal';
import { useI18n } from '../../src/i18n/i18nContext';
import { useTheme } from '../../src/theme/themeContext';

type TabRouteName = 'feed' | 'settings';

interface DockBarProps {
    activeTab: string;
    onTabPress: (key: TabRouteName) => void;
    onComposePress: () => void;
}

// The vendored floating glass dock, driven by expo-router's tab state. The
// compose button sits in the middle and opens the compose sheet as a modal
// overlay - compose is not a route.
function DockBar({ activeTab, onTabPress, onComposePress }: DockBarProps) {
    const { t } = useI18n();
    const tabs: TabDef[] = [
        { key: 'feed', label: t('timeline.feed'), icon: 'radio-outline', activeIcon: 'radio' },
        { key: 'settings', label: t('common.settings'), icon: 'settings-outline', activeIcon: 'settings' },
    ];
    return (
        <TabBar
            tabs={tabs}
            activeTab={activeTab}
            onTabPress={key => onTabPress(key as TabRouteName)}
            onComposePress={onComposePress}
            composeLabel={t('tabs.newPost')}
        />
    );
}

export default function TabsLayout() {
    const { colors } = useTheme();
    const { t } = useI18n();
    // Compose opens as a modal over whichever tab is active
    const [composeOpen, setComposeOpen] = useState(false);

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            <Tabs
                screenOptions={{ headerShown: false }}
                tabBar={props => (
                    <DockBar
                        activeTab={props.state.routes[props.state.index]?.name ?? 'feed'}
                        onTabPress={key => props.navigation.navigate(key)}
                        onComposePress={() => setComposeOpen(true)}
                    />
                )}
            >
                <Tabs.Screen name="feed" options={{ title: t('timeline.feed') }} />
                <Tabs.Screen name="settings" options={{ title: t('common.settings') }} />
            </Tabs>
            <ComposeModal isOpen={composeOpen} onClose={() => setComposeOpen(false)} />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
});
