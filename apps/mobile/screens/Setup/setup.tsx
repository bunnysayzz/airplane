import React, { useEffect, useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PillButton, PugMark, logoSizes } from '../../components/ui';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { useI18n } from '../../src/i18n/i18nContext';
import { EXPLAINER_CARDS, ExplainerCard } from './explainerCard';
import { markOnboardingDone } from './onboardingStatus';
import { makeStyles } from './styles';

// Setup never holds the user longer than this
export const SETUP_TIMEOUT_MS = 30_000;

// Boot status lines (setup.messages in the dictionaries) rotate at this pace
const MESSAGE_INTERVAL_MS = 2500;

interface SetupProps {
  onDone: () => void;
  // 0..1 while boot work runs; null/undefined means indeterminate (messages only)
  progress?: number | null;
  // When the caller knows boot work finished, passing ready moves to the explainer;
  // without it the timeout (or Skip) advances instead.
  ready?: boolean;
}

// Two phases: the boot splash (device identity load-or-generate, store init)
// first, then 2-3 swipeable anonymous-onboarding cards ending in a single Start
// button. There is no login, no account, no permissions begging - the
// Bluetooth/location rationale lives inline on card 1 as the pre-prompt copy
// for the real permission flows: location is primed on the publish path
// (composeModal asks first, the OS dialog only fires on the user's action),
// and the BLE stack is implemented (GattBlePort; radio interop unverified)
// with its permission priming owned by BlePrime on the feed tab, so nothing
// here may claim the OS prompts on this screen. The index route decides when to
// show Setup and uses onboardingStatus to show it once.
const Setup: React.FC<SetupProps> = ({ onDone, progress = null, ready = false }) => {
  const { type, coat } = useTheme();
  const { t, dict } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [booted, setBooted] = useState(false);
  const [card, setCard] = useState(0);
  // Guards the async Start press: storage is idempotent, but without this a
  // rapid double-tap would fire onDone twice with no feedback in between.
  // Declared above the `if (!booted)` early return on purpose: hooks must run
  // in the same order on every render (a conditional useState after an early
  // return throws "Rendered more hooks than during the previous render").
  const [finishing, setFinishing] = useState(false);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scroller = useRef<ScrollView>(null);

  const boot = useRef(() => {
    setBooted(true);
  }).current;

  // Boot splash: rotating status messages and progress bar
  const [message, setMessage] = useState(0);
  useEffect(() => {
    if (booted) return;
    const timeout = setTimeout(boot, SETUP_TIMEOUT_MS);
    const rotate = setInterval(() => setMessage((index) => index + 1), MESSAGE_INTERVAL_MS);
    return () => {
      clearTimeout(timeout);
      clearInterval(rotate);
    };
  }, [boot, booted]);
  useEffect(() => {
    if (ready) boot();
  }, [ready, boot]);

  const messages = dict.setup.messages;
  const percent = progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100);

  if (!booted) {
    return (
      <View style={styles.container}>
        <PugMark coat={coat} size={logoSizes.hero} />
        <Text accessibilityRole="header" style={[type.title, styles.title]}>
          {t('setup.title')}
        </Text>

        {/* The jokes are for sighted users; screen readers get the bar's percentage */}
        <Text
          style={[type.name, styles.message]}
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          {messages[message % messages.length]}…
        </Text>
        {percent !== null && (
          <View
            style={styles.track}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t('setup.title')}
            accessibilityValue={{ min: 0, max: 100, now: percent }}
          >
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
        )}

        <PillButton label={t('common.skip')} variant="ghost" onPress={boot} style={styles.skip} />
      </View>
    );
  }

  // Explainer: swipeable cards with pager dots and a single Next/Start button
  const isLast = card === EXPLAINER_CARDS.length - 1;

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(event.nativeEvent.contentOffset.x / width);
    setCard(Math.max(0, Math.min(EXPLAINER_CARDS.length - 1, page)));
  };

  const handlePrimary = async () => {
    if (!isLast) {
      scroller.current?.scrollTo({ x: width * (card + 1), animated: true });
      return;
    }
    if (finishing) return;
    setFinishing(true);
    try {
      await markOnboardingDone();
    } catch (error) {
      // Onboarding still completes; the flag is a convenience for the navigator
      console.error('Failed to persist onboarding completion:', error);
    }
    onDone();
  };

  return (
    <View style={[styles.container, styles.explainerContainer, { paddingTop: insets.top }]}>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        // Live updates too: a slow drag without fling never fires momentum,
        // which left the dots and the Next/Start label out of sync.
        onScroll={handleScroll}
        scrollEventThrottle={16}
        accessibilityLabel={t('setup.onboarding.explainerLabel')}
        style={styles.pager}
      >
        {EXPLAINER_CARDS.map((spec) => (
          // Vertical scroll fallback for short screens: the card centers when
          // it fits and scrolls when it doesn't (e.g. landscape phones).
          <ScrollView
            key={spec.key}
            contentContainerStyle={[styles.page, { width }]}
            showsVerticalScrollIndicator={false}
          >
            <ExplainerCard spec={spec} />
          </ScrollView>
        ))}
      </ScrollView>

      {/* Pager dots are decorative; the pager region carries the accessibility label */}
      <View style={styles.dots} importantForAccessibility="no" accessibilityElementsHidden>
        {EXPLAINER_CARDS.map((spec) => (
          <View
            key={spec.key}
            style={[styles.dot, spec.key === EXPLAINER_CARDS[card].key && styles.dotActive]}
          />
        ))}
      </View>

      <PillButton
        label={t(isLast ? 'setup.onboarding.start' : 'setup.onboarding.next')}
        onPress={handlePrimary}
        loading={finishing}
        style={[styles.primary, { marginBottom: Math.max(insets.bottom, 16) }]}
      />
    </View>
  );
};

export default Setup;
