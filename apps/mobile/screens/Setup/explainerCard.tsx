import React from 'react';
import { StyleProp, Text, View, ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { useI18n } from '../../src/i18n/i18nContext';
import type { TKey } from '../../src/i18n/translate';
import { makeCardStyles } from './styles';

export interface ExplainerCardSpec {
  key: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  titleKey: TKey;
  bodyKeys: TKey[];
  // Small-print lines (permission rationale, caveats) under the body
  noteKeys: TKey[];
}

// Airplane's onboarding explainer. Card index 1 is the binding privacy truth, so it is
// also rendered from Settings (in-app, so it works offline) as the compact privacy
// explainer. Card 0 carries the Bluetooth/location permission rationale inline as the
// pre-prompt copy the publish path primes with (location is the only real OS
// permission in v1; the mesh radio is still a P2/P3 no-op).
export const EXPLAINER_CARDS: ExplainerCardSpec[] = [
  {
    key: 'mesh',
    icon: 'airplane-outline',
    titleKey: 'setup.onboarding.card1Title',
    bodyKeys: ['setup.onboarding.card1Body'],
    noteKeys: ['setup.onboarding.card1Permission'],
  },
  {
    key: 'privacy',
    icon: 'megaphone-outline',
    titleKey: 'setup.onboarding.card2Title',
    bodyKeys: ['setup.onboarding.card2Body', 'setup.onboarding.card2Identity'],
    noteKeys: ['setup.onboarding.card2World'],
  },
  {
    key: 'ranking',
    icon: 'trending-up-outline',
    titleKey: 'setup.onboarding.card3Title',
    bodyKeys: ['setup.onboarding.card3Body'],
    noteKeys: [],
  },
];

interface ExplainerCardProps {
  spec: ExplainerCardSpec;
  style?: StyleProp<ViewStyle>;
}

// Terminology discipline (v1 launch gate): this copy says "anonymous" and "public".
// It never says "encrypted", "private" or "secure" about post contents.
export const ExplainerCard: React.FC<ExplainerCardProps> = ({ spec, style }) => {
  const { colors, type } = useTheme();
  const { t } = useI18n();
  const styles = useThemedStyles(makeCardStyles);

  return (
    <View style={[styles.card, style]}>
      <View style={styles.iconCircle} importantForAccessibility="no" accessibilityElementsHidden>
        <Ionicons name={spec.icon} size={34} color={colors.accentText} />
      </View>
      <Text accessibilityRole="header" style={[type.title, styles.title]}>
        {t(spec.titleKey)}
      </Text>
      {spec.bodyKeys.map((key) => (
        <Text key={key} style={[type.body, styles.body]}>
          {t(key)}
        </Text>
      ))}
      {spec.noteKeys.map((key) => (
        <Text key={key} style={[type.meta, styles.note]}>
          {t(key)}
        </Text>
      ))}
    </View>
  );
};
