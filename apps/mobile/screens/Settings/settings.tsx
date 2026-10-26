import React, { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSettings } from '../../src/lib/settingsContext';
import { useTheme } from '../../src/theme/themeContext';
import { getCoat } from '../../src/theme/coats';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { Card, PugMark, SectionLabel, ThemedSwitch, logoSizes } from '../../components/ui';
import { appVersionLabel } from '../../src/lib/appVersion';
import { checkForUpdateFromSettings } from '../../src/lib/updateCheck';
import { dialog } from '../../src/lib/dialog';
import Appearance from './appearance';
import Relays from './relays';
import Identity from './identity';
import Diagnostics from './diagnostics';
import { SettingsHeader } from './header';
import { makeStyles } from './styles';
import { useI18n } from '../../src/i18n/i18nContext';
import { tabBarClearance } from '../../components/TabBar/styles';
import { EXPLAINER_CARDS, ExplainerCard } from '../Setup/explainerCard';

// Deliberately opened in-app instead of a browser link: Airplane is an offline-first,
// sideloaded app - at a protest or on a plane there may be no internet to fetch
// GitHub. The same content is the onboarding privacy card (EXPLAINER_CARDS[1]).
// The full PRIVACY.md is linked at the bottom for when the user is online.
const PRIVACY_URL = 'https://github.com/bunnysayzz/airplane/blob/main/PRIVACY.md';

interface SettingsProps {
  onBack: () => void;
}

// Pugdon's settings stripped for Airplane: no accounts (anonymous), no language picker
// (English-only v1), no quote policy, no push/media switches, no logout. What survives:
// Appearance (theme coats), the compact-mode preference, and About.
const Settings: React.FC<SettingsProps> = ({ onBack }) => {
  const { colors, type, coat } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { compactMode, setCompactMode } = useSettings();
  // Appearance, Relays, Identity, Diagnostics and the privacy explainer
  // are second levels inside Settings
  const [page, setPage] = useState<
    'main' | 'appearance' | 'relays' | 'identity' | 'diagnostics' | 'privacy'
  >('main');
  const { t } = useI18n();
  const coatName = t(`coats.${getCoat(coat).key}`);
  // T14: manual update check. Android only — a sideloaded iOS app cannot
  // install itself, so no iOS updater is offered (see updateCheck.ts).
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'uptodate' | 'available' | 'failed'
  >('idle');
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  const onCheckForUpdates = () => {
    if (updateStatus === 'checking') return;
    setUpdateStatus('checking');
    checkForUpdateFromSettings()
      .then((result) => {
        if (result.available && result.update) {
          // The prompt itself is shown by the check; the row just remembers it.
          setUpdateVersion(result.update.version);
          setUpdateStatus('available');
        } else if (result.error) {
          setUpdateStatus('failed');
          dialog.toast(t('settings.updateCheckFailed'));
        } else {
          setUpdateStatus('uptodate');
        }
      })
      .catch(() => {
        setUpdateStatus('failed');
        dialog.toast(t('settings.updateCheckFailed'));
      });
  };

  const updateRowText =
    updateStatus === 'checking'
      ? t('settings.updateChecking')
      : updateStatus === 'available' && updateVersion
        ? t('settings.updateAvailable', { version: updateVersion })
        : updateStatus === 'uptodate'
          ? t('settings.updateUpToDate')
          : updateStatus === 'failed'
            ? t('settings.updateCheckFailed')
            : '';

  if (page === 'appearance') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Appearance onBack={() => setPage('main')} />
      </SafeAreaView>
    );
  }

  if (page === 'relays') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Relays onBack={() => setPage('main')} />
      </SafeAreaView>
    );
  }

  if (page === 'identity') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Identity onBack={() => setPage('main')} />
      </SafeAreaView>
    );
  }

  if (page === 'diagnostics') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Diagnostics onBack={() => setPage('main')} />
      </SafeAreaView>
    );
  }

  if (page === 'privacy') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <SettingsHeader
          title={t('settings.privacy')}
          onBack={() => setPage('main')}
          backLabel={t('appearance.back')}
        />
        <ScrollView
          contentContainerStyle={[
            styles.contentContainer,
            { paddingBottom: tabBarClearance(insets.bottom) },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[type.body, styles.privacyLead]}>{t('settings.privacyLead')}</Text>
          <Card style={styles.privacyCard}>
            <ExplainerCard spec={EXPLAINER_CARDS[1]} />
          </Card>
          <Pressable
            style={styles.fullPolicyRow}
            onPress={() =>
              Linking.openURL(PRIVACY_URL).catch((error) =>
                console.error('Failed to open privacy policy:', error),
              )
            }
            accessibilityRole="link"
          >
            <Text style={[type.name, styles.fullPolicyText]}>
              {t('settings.privacyFullPolicy')}
            </Text>
            <Ionicons name="open-outline" size={16} color={colors.textMuted} />
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const labelStyle = [type.name, styles.rowLabel];

  return (
    <SafeAreaView style={styles.safeArea}>
      <SettingsHeader title={t('settings.title')} onBack={onBack} backLabel={t('settings.close')} />

      <ScrollView
        contentContainerStyle={[
          styles.contentContainer,
          { paddingBottom: tabBarClearance(insets.bottom) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <SectionLabel style={styles.sectionLabel}>{t('settings.preferences')}</SectionLabel>
        <Card style={styles.group}>
          <Pressable
            style={styles.row}
            onPress={() => setPage('appearance')}
            accessibilityRole="button"
            accessibilityLabel={t('settings.appearanceLabel', { coat: coatName })}
            accessibilityHint={t('settings.appearanceHint')}
          >
            <Ionicons name="color-palette-outline" size={20} color={colors.accentText} />
            <Text style={[labelStyle, styles.rowText]}>{t('settings.appearance')}</Text>
            <View style={styles.rowTrailing}>
              <PugMark coat={coat} size={logoSizes.row} />
              <Text style={[type.meta, styles.rowValue]}>{coatName}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={styles.row}
            onPress={() => setPage('relays')}
            accessibilityRole="button"
            accessibilityLabel={t('settings.relaysTitle')}
            accessibilityHint={t('settings.relaysHint')}
          >
            <Ionicons name="globe-outline" size={20} color={colors.accentText} />
            <Text style={[labelStyle, styles.rowText]}>{t('settings.relaysTitle')}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={styles.row}
            onPress={() => setPage('identity')}
            accessibilityRole="button"
            accessibilityLabel={t('settings.identityTitle')}
            accessibilityHint={t('settings.identityHint')}
          >
            <Ionicons name="key-outline" size={20} color={colors.accentText} />
            <Text style={[labelStyle, styles.rowText]}>{t('settings.identityTitle')}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={styles.row}
            onPress={() => setPage('diagnostics')}
            accessibilityRole="button"
            accessibilityLabel={t('settings.diagnosticsTitle')}
            accessibilityHint={t('settings.diagnosticsHint')}
          >
            <Ionicons name="pulse-outline" size={20} color={colors.accentText} />
            <Text style={[labelStyle, styles.rowText]}>{t('settings.diagnosticsTitle')}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Ionicons name="list-outline" size={20} color={colors.accentText} />
            <Text style={[labelStyle, styles.rowText]}>{t('settings.compactMode')}</Text>
            <ThemedSwitch
              value={compactMode}
              onValueChange={setCompactMode}
              accessibilityLabel={t('settings.compactMode')}
            />
          </View>
        </Card>

        <SectionLabel style={styles.sectionLabel}>{t('settings.about')}</SectionLabel>
        <Card style={styles.group}>
          <View style={styles.row}>
            <Ionicons name="information-circle-outline" size={20} color={colors.accentText} />
            <Text style={[labelStyle, styles.rowText]}>{t('settings.version')}</Text>
            <Text style={[type.meta, styles.rowValue]}>{appVersionLabel()}</Text>
          </View>
          {Platform.OS === 'android' && (
            <>
              <View style={styles.divider} />
              <Pressable
                style={styles.row}
                onPress={onCheckForUpdates}
                accessibilityRole="button"
                accessibilityLabel={t('settings.updateCheck')}
              >
                <Ionicons name="arrow-down-circle-outline" size={20} color={colors.accentText} />
                <Text style={[labelStyle, styles.rowText]}>{t('settings.updateCheck')}</Text>
                {updateRowText ? (
                  <Text style={[type.meta, styles.rowValue]}>{updateRowText}</Text>
                ) : (
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                )}
              </Pressable>
            </>
          )}
          <View style={styles.divider} />
          <Pressable
            style={styles.row}
            onPress={() => setPage('privacy')}
            accessibilityRole="button"
            accessibilityLabel={t('settings.privacy')}
            accessibilityHint={t('settings.privacyHint')}
          >
            <Ionicons name="shield-checkmark-outline" size={20} color={colors.accentText} />
            <Text style={[labelStyle, styles.rowText]}>{t('settings.privacy')}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </Pressable>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
};

export default Settings;
