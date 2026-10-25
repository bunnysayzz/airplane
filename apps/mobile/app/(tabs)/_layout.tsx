import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { TabBar, type TabDef } from '../../components/TabBar/tabBar';
import ComposeModal from '../../components/ComposeModal/composeModal';
import { ComposeOpenContext } from '../../components/ComposeModal/composeContext';
import { useI18n } from '../../src/i18n/i18nContext';
import { useTheme } from '../../src/theme/themeContext';
import { getDmService } from '../../services/airplane/dm';

type TabRouteName = 'feed' | 'messages' | 'settings';

interface DockBarProps {
    activeTab: string;
    onTabPress: (key: TabRouteName) => void;
    onComposePress: () => void;
    unreadBadge: boolean;
}

// The vendored floating glass dock, driven by expo-router's tab state. The
// compose button sits in the middle and opens the compose sheet as a modal
// overlay - compose is not a route.
function DockBar({ activeTab, onTabPress, onComposePress, unreadBadge }: DockBarProps) {
    const { t } = useI18n();
    // DM P1: messages tab with unread badge (inbox-only total, muted excluded).
    // Compose stays in the middle via the TabBar's existing insertion pattern.
    const tabs: TabDef[] = [
        { key: 'feed', label: t('timeline.feed'), icon: 'radio-outline', activeIcon: 'radio' },
        { key: 'messages', label: 'Messages', icon: 'chatbubble-outline', activeIcon: 'chatbubble', badge: unreadBadge },
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
    const openCompose = useCallback(() => setComposeOpen(true), []);
    // DM unread badge: refreshes on every DM service change (send, receive,
    // mark-read). Failures here must never break the dock — badge just hides.
    const [unreadBadge, setUnreadBadge] = useState(false);
    useEffect(() => {
        let unsub: (() => void) | undefined;
        let alive = true;
        getDmService()
            .then(svc => {
                if (!alive) return;
                const update = () => {
                    void svc.totalUnread().then(n => {
                        if (alive) setUnreadBadge(n > 0);
                    });
                };
                unsub = svc.subscribe(update);
                update();
            })
            .catch(() => {});
        return () => {
            alive = false;
            unsub?.();
        };
    }, []);

    return (
        <ComposeOpenContext.Provider value={openCompose}>
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            <Tabs
                screenOptions={{ headerShown: false }}
                tabBar={props => (
                    <DockBar
                        activeTab={props.state.routes[props.state.index]?.name ?? 'feed'}
                        onTabPress={key => props.navigation.navigate(key)}
                        onComposePress={openCompose}
                        unreadBadge={unreadBadge}
                    />
                )}
            >
                <Tabs.Screen name="feed" options={{ title: t('timeline.feed') }} />
                <Tabs.Screen name="messages" options={{ title: 'Messages' }} />
                <Tabs.Screen name="settings" options={{ title: t('common.settings') }} />
            </Tabs>
            <ComposeModal isOpen={composeOpen} onClose={() => setComposeOpen(false)} />
        </View>
        </ComposeOpenContext.Provider>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
});
