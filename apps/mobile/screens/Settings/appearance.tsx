import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar, Card, PugMark, SectionLabel, SegmentedPill, SegmentOption, ThemedSwitch, logoSizes } from '../../components/ui';
import { ThemeType, useTheme } from '../../src/theme/themeContext';
import { COATS, getCoat } from '../../src/theme/coats';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { SettingsHeader } from './header';
import { makeAppearanceStyles } from './styles';
import { tabBarClearance } from '../../components/TabBar/styles';
import { useI18n } from '../../src/i18n/i18nContext';

const MODES: ThemeType[] = ['light', 'dark', 'system'];

interface AppearanceProps {
    onBack: () => void;
}

const Appearance: React.FC<AppearanceProps> = ({ onBack }) => {
    const { colors, type, theme, setTheme, coat, setCoat, tint, setTint } = useTheme();
    const styles = useThemedStyles(makeAppearanceStyles);
    const insets = useSafeAreaInsets();
    const { t } = useI18n();
    const coatName = t(`coats.${getCoat(coat).key}`);
    const modes: SegmentOption<ThemeType>[] = MODES.map(value => ({ value, label: t(`appearance.${value}`) }));

    return (
        <>
            <SettingsHeader title={t('appearance.title')} onBack={onBack} backLabel={t('appearance.back')} />
            <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance(insets.bottom) }]} showsVerticalScrollIndicator={false}>
                <SectionLabel style={styles.sectionLabel}>{t('appearance.preview')}</SectionLabel>
                {/* A sample post drawn with the live tokens; read as one element and not interactive */}
                <Card style={styles.preview} accessible accessibilityLabel={t('appearance.previewLabel', { coat: coatName })} pointerEvents="none">
                    <View style={styles.previewAuthor}>
                        <Avatar name="quiet fox·a3f9" size={38} />
                        <View style={styles.previewNames}>
                            <Text style={[type.name, styles.previewName]}>quiet fox·a3f9</Text>
                            <Text style={[type.meta, styles.previewHandle]}>quiet fox·a3f9</Text>
                        </View>
                    </View>
                    <Text style={[type.body, styles.previewBody]}>
                        {t('appearance.previewText', { coat: coatName })} <Text style={[type.name, styles.previewTag]}>#airplane</Text>
                    </Text>
                    <View style={styles.pollBar}>
                        <View style={styles.pollFill} />
                        <View style={styles.pollLabels}>
                            <Text style={[type.meta, styles.pollOption]}>{t('appearance.previewPost')}</Text>
                            <Text style={[type.meta, styles.pollPercent]}>64%</Text>
                        </View>
                    </View>
                    <View style={styles.previewActions}>
                        <View style={styles.previewAction}>
                            <Ionicons name="arrow-undo-outline" size={18} color={colors.textMuted} />
                            <Text style={[type.meta, styles.previewCount]}>6</Text>
                        </View>
                        <View style={styles.previewAction}>
                            <Ionicons name="repeat" size={18} color={colors.textMuted} />
                            <Text style={[type.meta, styles.previewCount]}>2</Text>
                        </View>
                        <View style={styles.previewAction}>
                            <Ionicons name="star" size={18} color={colors.accentText} />
                            <Text style={[type.meta, styles.previewCountActive]}>19</Text>
                        </View>
                    </View>
                </Card>

                <SectionLabel style={styles.sectionLabel}>{t('appearance.mode')}</SectionLabel>
                <SegmentedPill
                    options={modes}
                    value={theme}
                    onChange={setTheme}
                    accessibilityLabel={t('appearance.mode')}
                />

                <View style={styles.coatHeader}>
                    <SectionLabel>{t('appearance.coat')}</SectionLabel>
                    <Text style={[type.meta, styles.coatHint]}>{t('appearance.coatHint')}</Text>
                </View>
                <View accessibilityRole="radiogroup" style={styles.coatGrid}>
                    {COATS.map(option => {
                        const selected = option.key === coat;
                        return (
                            <Pressable
                                key={option.key}
                                onPress={() => setCoat(option.key)}
                                accessibilityRole="radio"
                                accessibilityLabel={t(`coats.${option.key}`)}
                                accessibilityState={{ checked: selected }}
                                style={[styles.coat, selected && styles.coatSelected]}
                            >
                                <PugMark coat={option.key} size={logoSizes.coat} />
                                <Text style={[type.meta, styles.coatName]}>{t(`coats.${option.key}`)}</Text>
                            </Pressable>
                        );
                    })}
                </View>

                <Card style={styles.tintRow}>
                    <View style={styles.tintText}>
                        <Text style={[type.name, styles.tintLabel]}>{t('appearance.tint')}</Text>
                        <Text style={[type.meta, styles.tintDetail]}>{t('appearance.tintHint')}</Text>
                    </View>
                    <ThemedSwitch value={tint} onValueChange={setTint} accessibilityLabel={t('appearance.tint')} />
                </Card>
            </ScrollView>
        </>
    );
};

export default Appearance;
