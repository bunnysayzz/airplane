import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Card, SectionLabel } from '../../components/ui';
import { useSettings } from '../../src/lib/settingsContext';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { SettingsHeader } from './header';
import { makeRelayStyles } from './styles';
import { tabBarClearance } from '../../components/TabBar/styles';
import { useI18n } from '../../src/i18n/i18nContext';

interface RelaysProps {
    onBack: () => void;
}

// Second-level Settings page (same pattern as Appearance): lists the Nostr
// relays the World uplink publishes to, lets the user add a custom relay
// and remove any relay, and resets to the defaults. Changes are persisted
// immediately but apply on the next app start — the transport is built
// with its relay list at launch and is never torn down live (see
// settingsContext.tsx), so the page says so instead of implying otherwise.
const Relays: React.FC<RelaysProps> = ({ onBack }) => {
    const { colors, type } = useTheme();
    const styles = useThemedStyles(makeRelayStyles);
    const insets = useSafeAreaInsets();
    const { t } = useI18n();
    const { relays, relaysCustomized, addRelay, removeRelay, resetRelays } = useSettings();
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);

    const handleAdd = async () => {
        const ok = await addRelay(draft);
        if (ok) {
            setDraft('');
            setError(null);
        } else {
            setError(t('settings.relaysInvalid'));
        }
    };

    return (
        <>
            <SettingsHeader title={t('settings.relaysTitle')} onBack={onBack} backLabel={t('appearance.back')} />
            {/* F10: same keyboard rule as the DM thread: iOS gets a padding
                avoiding view so the add row is never covered; on Android the
                view is inert and the manifest's adjustResize mode lifts it.
                The parent SafeAreaView is flex 1, so the avoiding view fills
                the page. Persisting taps lets Add fire while the keyboard is
                open instead of merely dismissing it. */}
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView
                contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance(insets.bottom) }]}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                <Text style={[type.body, styles.lead]}>{t('settings.relaysLead')}</Text>
                <Text style={[type.meta, styles.restartNote]}>{t('settings.relaysRestartNote')}</Text>

                <SectionLabel style={styles.sectionLabel}>{t('settings.relaysList')}</SectionLabel>
                <Card style={styles.group}>
                    {relays.length === 0 ? (
                        <Text style={[type.body, styles.empty]}>{t('settings.relaysEmpty')}</Text>
                    ) : (
                        relays.map((url, index) => (
                            <React.Fragment key={url}>
                                {index > 0 && <View style={styles.divider} />}
                                <View style={styles.row}>
                                    <Ionicons name="globe-outline" size={20} color={colors.accentText} />
                                    <Text style={[type.name, styles.rowText]} numberOfLines={1}>
                                        {url}
                                    </Text>
                                    <Pressable
                                        onPress={() => void removeRelay(url)}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('settings.relaysRemove', { url })}
                                        hitSlop={12}
                                    >
                                        <Ionicons name="trash-outline" size={20} color={colors.textMuted} />
                                    </Pressable>
                                </View>
                            </React.Fragment>
                        ))
                    )}
                </Card>

                <SectionLabel style={styles.sectionLabel}>{t('settings.relaysAdd')}</SectionLabel>
                <Card style={styles.group}>
                    <View style={styles.addRow}>
                        <TextInput
                            style={[type.body, styles.input]}
                            value={draft}
                            onChangeText={(value) => {
                                setDraft(value);
                                setError(null);
                            }}
                            placeholder={t('settings.relaysPlaceholder')}
                            placeholderTextColor={colors.textMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            accessibilityLabel={t('settings.relaysAdd')}
                            onSubmitEditing={() => void handleAdd()}
                        />
                        <Pressable
                            style={[styles.addButton, draft.trim().length === 0 && styles.addButtonDisabled]}
                            onPress={() => void handleAdd()}
                            disabled={draft.trim().length === 0}
                            accessibilityRole="button"
                            accessibilityLabel={t('settings.relaysAdd')}
                        >
                            <Text style={[type.name, styles.addButtonText]}>{t('settings.relaysAdd')}</Text>
                        </Pressable>
                    </View>
                    {error !== null && <Text style={[type.meta, styles.error]}>{error}</Text>}
                </Card>

                {relaysCustomized && (
                    <Pressable
                        style={styles.resetRow}
                        onPress={() => void resetRelays()}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.relaysReset')}
                    >
                        <Text style={[type.name, styles.resetText]}>{t('settings.relaysReset')}</Text>
                    </Pressable>
                )}
            </ScrollView>
            </KeyboardAvoidingView>
        </>
    );
};

export default Relays;
