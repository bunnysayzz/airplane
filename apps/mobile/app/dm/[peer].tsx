// SPDX-License-Identifier: Apache-2.0
// DM P1 thread view: chronological bubbles, text-only send box, delivery
// states Sending / Sent / Failed (Failed = tap to retry, never silently
// dropped). No read receipts, in either direction. Delete is LOCAL ONLY and
// the confirm copy says so. Requests landing here get Accept / Block / Ignore.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DmConversationRow, DmThreadRow } from '@airplane/transport';
import { getDmService, dmPeerLabel, sendDm } from '../../services/airplane/dm';
import { isNearBottom } from '../../src/lib/dmThread';
import { DmBubble } from '../../components/DmBubble';
import { useTheme } from '../../src/theme/themeContext';

export default function DmThreadScreen() {
    const { peer } = useLocalSearchParams<{ peer: string }>();
    const peerHex = (peer ?? '').toLowerCase();
    const insets = useSafeAreaInsets();
    const { colors, type } = useTheme();
    const [thread, setThread] = useState<DmThreadRow[]>([]);
    const [conv, setConv] = useState<DmConversationRow | null>(null);
    const [draft, setDraft] = useState('');

    // F4: the thread lands on the latest message and follows new arrivals,
    // but only while the user is already near the bottom, so reading history
    // is never yanked away. The list ref and the two refs below are the
    // whole mechanism: onScroll tracks nearness, onContentSizeChange drives
    // the scroll (content size changes exactly when messages arrive).
    const listRef = useRef<FlatList<DmThreadRow>>(null);
    const nearBottomRef = useRef(true);
    const initialScrollDoneRef = useRef(false);
    const handleListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        nearBottomRef.current = isNearBottom({
            contentHeight: contentSize.height,
            offsetY: contentOffset.y,
            viewportHeight: layoutMeasurement.height,
        });
    }, []);
    const handleListContentSizeChange = useCallback(() => {
        if (!initialScrollDoneRef.current) {
            initialScrollDoneRef.current = true;
            listRef.current?.scrollToEnd({ animated: false });
        } else if (nearBottomRef.current) {
            listRef.current?.scrollToEnd({ animated: true });
        }
    }, []);

    const refresh = useCallback(() => {
        void getDmService().then(async svc => {
            setThread(await svc.getThread(peerHex));
            const inbox = await svc.listInbox();
            const requests = await svc.listRequests();
            const blocked = await svc.listBlocked();
            setConv([...inbox, ...requests, ...blocked].find(c => c.peerHex === peerHex) ?? null);
        });
    }, [peerHex]);

    useEffect(() => {
        refresh();
        let unsub: (() => void) | undefined;
        void getDmService().then(svc => {
            unsub = svc.subscribe(refresh);
            void svc.markRead(peerHex);
        });
        return () => unsub?.();
    }, [refresh, peerHex]);

    const send = () => {
        const text = draft.trim();
        if (!text) return;
        setDraft('');
        sendDm(peerHex, text)
            .then(refresh)
            .catch((e: unknown) => Alert.alert('Could not send', e instanceof Error ? e.message : 'Unknown error'));
    };

    // F5: stable retry + renderItem so keystrokes in the draft input do not
    // re-render bubbles. The retry chain is unchanged from the previous
    // inline handler (retry, flush outbox, refresh); only its identity is
    // now stable, which is what makes the DmBubble memo comparison hold.
    const handleRetry = useCallback(
        (messageId: string) => {
            void getDmService()
                .then(svc => svc.retryMessage(peerHex, messageId))
                .then(() => getDmService().then(svc => svc.flushOutbox()))
                .then(refresh);
        },
        [peerHex, refresh],
    );
    const renderItem = useCallback(
        ({ item }: { item: DmThreadRow }) => <DmBubble item={item} onRetry={handleRetry} />,
        [handleRetry],
    );

    // Returns true on success, false after showing an error: actions used
    // to fail silently (a bare act() rejection went nowhere), and Delete
    // must not navigate back when it fails, so callers check the result.
    const act = (fn: (svc: Awaited<ReturnType<typeof getDmService>>) => Promise<void>): Promise<boolean> =>
        getDmService()
            .then(svc => fn(svc))
            .then(refresh)
            .then(() => true)
            .catch((e: unknown) => {
                Alert.alert('Action failed', e instanceof Error ? e.message : 'Unknown error');
                return false;
            });

    const confirmDelete = () => {
        Alert.alert(
            'Delete conversation?',
            'This only deletes from your device. The relay copy and the other person\'s copy stay exactly where they are. Unsend is not possible.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () =>
                        act(svc => svc.deleteConversationLocalOnly(peerHex)).then(ok => {
                            if (ok) router.back();
                        }),
                },
            ],
        );
    };

    const isRequest = conv?.state === 'request';

    // F10: the keyboard must never cover the input and Send button. iOS has
    // no window resize, so a padding avoiding view lifts the send row; on
    // Android the view is inert and the manifest's adjustResize window mode
    // does the same job (no double adjustment). The avoiding view is the
    // screen root, so no vertical offset is needed.
    return (
        <KeyboardAvoidingView style={[styles.root, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={[styles.header, { borderBottomColor: colors.borderColor, paddingTop: insets.top + 16 }]}>
                <Pressable onPress={() => router.back()}>
                    <Text style={[type.meta, { color: colors.accentText }]}>Back</Text>
                </Pressable>
                <Text style={[type.name, { color: colors.textPrimary }]}>{dmPeerLabel(peerHex)}</Text>
                <View style={styles.headerSpacer} />
            </View>

            {isRequest ? (
                <View style={[styles.requestBar, { borderBottomColor: colors.borderColor }]}>
                    <Text style={[type.meta, { color: colors.textMuted }]}>Unknown sender. This started in Requests.</Text>
                    <View style={styles.requestRow}>
                        <Pressable
                            style={[styles.actionButton, { backgroundColor: colors.accentColor }]}
                            onPress={() => act(svc => svc.acceptRequest(peerHex))}
                        >
                            <Text style={[type.name, { color: colors.buttonTextColor }]}>Accept</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.actionButton, { backgroundColor: colors.dangerColor }]}
                            onPress={() => act(svc => svc.blockPeer(peerHex))}
                        >
                            <Text style={[type.name, { color: colors.buttonTextColor }]}>Block</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.actionButton, styles.actionNeutral, { borderColor: colors.borderColor }]}
                            onPress={() => act(svc => svc.ignoreRequest(peerHex))}
                        >
                            <Text style={[type.name, { color: colors.textPrimary }]}>Ignore</Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}

            <View style={[styles.actions, { borderBottomColor: colors.borderColor }]}>
                <Pressable
                    style={[styles.actionButton, { backgroundColor: colors.accentColor }]}
                    onPress={() => act(svc => svc.mutePeer(peerHex, !(conv?.muted ?? false)))}
                >
                    <Text style={[type.name, { color: colors.buttonTextColor }]}>{conv?.muted ? 'Unmute' : 'Mute'}</Text>
                </Pressable>
                <Pressable
                    style={[styles.actionButton, { backgroundColor: colors.dangerColor }]}
                    onPress={() => act(svc => svc.blockPeer(peerHex))}
                >
                    <Text style={[type.name, { color: colors.buttonTextColor }]}>Block</Text>
                </Pressable>
                <Pressable
                    style={[styles.actionButton, { backgroundColor: colors.dangerColor }]}
                    onPress={confirmDelete}
                >
                    <Text style={[type.name, { color: colors.buttonTextColor }]}>Delete (this device only)</Text>
                </Pressable>
            </View>

            <FlatList
                ref={listRef}
                data={thread}
                keyExtractor={item => item.id}
                contentContainerStyle={styles.list}
                onScroll={handleListScroll}
                scrollEventThrottle={100}
                onContentSizeChange={handleListContentSizeChange}
                renderItem={renderItem}
                keyboardShouldPersistTaps="handled"
            />

            <View style={[styles.sendRow, { borderTopColor: colors.borderColor, paddingBottom: insets.bottom + 12 }]}>
                <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Message (text only)"
                    placeholderTextColor={colors.textMuted}
                    multiline
                    style={[styles.input, { color: colors.textPrimary, borderColor: colors.borderColor }]}
                />
                <Pressable onPress={send} style={[styles.send, { backgroundColor: colors.accentColor }]}>
                    <Text style={{ color: colors.buttonTextColor }}>Send</Text>
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
    headerSpacer: { flex: 1 },
    requestBar: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
    requestRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
    actions: { flexDirection: 'row', gap: 16, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexWrap: 'wrap' },
    actionButton: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
    actionNeutral: { borderWidth: 1 },
    list: { padding: 16, gap: 8 },
    sendRow: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
    input: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10, maxHeight: 120 },
    send: { borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
});
