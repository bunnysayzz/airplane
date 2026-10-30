// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, SectionLabel } from '../../components/ui';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { SettingsHeader } from './header';
import { makeDiagnosticsStyles } from './styles';
import { tabBarClearance } from '../../components/TabBar/styles';
import { useI18n } from '../../src/i18n/i18nContext';

interface BackgroundProps {
  onBack: () => void;
}

// Second-level Settings page (R6, plan section 6 fix 6): the guided
// background-survival flow. Honest about the current limit: this version
// has no permanent foreground service, so a locked phone is not guaranteed
// to receive mesh posts while locked. What it does get on foreground
// return is the radio revalidation plus the relay sync, so relay posts
// show up when the app is reopened. The OEM steps below are the ones
// that keep Android from killing the app in the background; the app
// cannot read the battery exemption state, so Diagnostics reports it as
// unavailable rather than guessing.
const Background: React.FC<BackgroundProps> = ({ onBack }) => {
  const { type } = useTheme();
  const styles = useThemedStyles(makeDiagnosticsStyles);
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  return (
    <>
      <SettingsHeader
        title={t('settings.backgroundTitle')}
        onBack={onBack}
        backLabel={t('appearance.back')}
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: tabBarClearance(insets.bottom) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.body, styles.lead]}>{t('settings.backgroundLead')}</Text>
        <Text style={[type.body, styles.lead]}>{t('settings.backgroundNoService')}</Text>
        <Text style={[type.body, styles.lead]}>{t('settings.backgroundOnReturn')}</Text>
        <SectionLabel style={styles.sectionLabel}>{t('settings.backgroundOem')}</SectionLabel>
        <Card style={styles.group}>
          <Text style={[type.body, styles.kvValue]}>{t('settings.backgroundSamsung')}</Text>
          <Text style={[type.body, styles.kvValue]}>{t('settings.backgroundXiaomi')}</Text>
          <Text style={[type.body, styles.kvValue]}>{t('settings.backgroundOnePlus')}</Text>
          <Text style={[type.body, styles.kvValue]}>{t('settings.backgroundPixel')}</Text>
        </Card>
        <View style={styles.buttonRow}>
          <Pressable
            style={styles.button}
            onPress={() => void Linking.openSettings()}
            accessibilityRole="button"
            accessibilityLabel={t('settings.backgroundOpenSettings')}
          >
            <Text style={[type.name, styles.buttonText]}>
              {t('settings.backgroundOpenSettings')}
            </Text>
          </Pressable>
        </View>
        <Text style={[type.meta, styles.note]}>
          {t('settings.backgroundOpenSettingsNote')}
        </Text>
      </ScrollView>
    </>
  );
};

export default Background;
