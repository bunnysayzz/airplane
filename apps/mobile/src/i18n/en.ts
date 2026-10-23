// English, the source of truth for keys: pt-BR must have the same shape (see Dictionary)
// {{name}} is filled in by t(); keys ending in _one / _other are picked by tn() for a count
export const en = {
  common: {
    cancel: 'Cancel',
    ok: 'OK',
    close: 'Close',
    skip: 'Skip',
    settings: 'Settings',
    goBack: 'Go back',
  },
  tabs: {
    newPost: 'New post',
  },
  meshStatus: {
    // Peers seen on the mesh; stays 0 until the transport lands (no fake numbers)
    nearby_one: '{{count}} nearby',
    nearby_other: '{{count}} nearby',
    meshOnly: 'mesh only',
    online: 'online',
    offline: 'offline',
    a11y: '{{peers}}, {{status}}',
  },
  setup: {
    title: 'Setting things up',
    // Plain status lines shown while first-time boot work runs
    messages: [
      'Generating your keys',
      'Setting up your store',
      'Waking up the mesh',
      'Finding nearby phones',
      'Tuning the radio',
      'Loading the feed',
      'Getting everything ready',
      'Almost there',
    ],
    onboarding: {
      // The swipeable cards shown after the boot splash
      explainerLabel: 'How Airplane works',
      card1Title: 'The feed that works in airplane mode',
      card1Body:
        'Posts hop phone-to-phone over Bluetooth. No account. No servers. No sign-up, ever.',
      card1Permission:
        'Airplane needs Bluetooth and location access to find nearby phones and relay posts. Nothing about you is collected.',
      card2Title: 'Public posts. Anonymous people.',
      card2Body: 'Everyone nearby can read what you post. Nobody knows it’s you.',
      card2Identity:
        'There are no accounts, no names, no phone numbers - just a random tag like anon·a3f9 that marks posts as yours.',
      card2World: 'Posts may reach the wider network through other phones. A tiny globe marks posts that made it out.',
      card3Title: 'Views decide what rises',
      card3Body: 'No likes. No followers. The more a post is seen, the higher it climbs the feed.',
      next: 'Next',
      start: 'Start',
    },
  },
  timeline: {
    // Airplane's single feed
    feed: 'Feed',
    empty: 'Nothing here yet - be the first to post.',
    newPosts_one: '{{count}} new post',
    newPosts_other: '{{count}} new posts',
    newPostsHint: 'Loads them and goes to the top',
    loadFailed: "Couldn't load the feed. Try again.",
    retry: 'Retry',
  },
  thread: {
    title: 'Post',
    titleBy: 'Post by {{name}}',
    notFound: 'This post could not be found.',
  },
  compose: {
    newPost: 'New post',
    post: 'Post',
    placeholder: "What's on your mind?",
    textLabel: 'Post text',
    discardTitle: 'Discard this post?',
    discardMessage: 'Your draft will be lost.',
    keepEditing: 'Keep editing',
    discard: 'Discard',
    publishFailed: 'Publishing failed',
    publishFailedMessage: 'An error occurred while publishing your post.',
    locationPaused: "Location isn't available yet, so posting is paused.",
    charactersLeft: '{{count}} characters left',
    charactersOver: '{{count}} characters over the limit',
    overShort: '{{count}} over',
    posted: 'Post published',
  },
  settings: {
    title: 'Settings',
    close: 'Close settings',
    preferences: 'Preferences',
    appearance: 'Appearance',
    appearanceLabel: 'Appearance, {{coat}}',
    compactMode: 'Compact Mode',
    about: 'About',
    version: 'App Version',
    privacy: 'Privacy Policy',
    // The in-app privacy page reuses onboarding card 2; full policy is PRIVACY.md in the repo
    privacyLead:
      'The short, honest version. Nobody can identify you here, but nothing you write is hidden.',
    privacyFullPolicy: 'Read the full privacy policy (PRIVACY.md)',
  },
  // Each language's name in its own language
  appearance: {
    title: 'Appearance',
    back: 'Back to settings',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    preview: 'Preview',
    previewLabel: 'Preview of the {{coat}} coat',
    previewText: 'Trying airplane in {{coat}}.',
    previewPost: 'In a sunbeam',
    mode: 'Mode',
    coat: 'Coat',
    coatHint: 'Pick a color',
    tint: 'Tint surfaces with coat',
    tintHint: 'Warms the background and cards, not only buttons',
  },
  coats: {
    apricot: 'Apricot',
    fawn: 'Fawn',
    brindle: 'Brindle',
    black: 'Black',
    silver: 'Silver',
    sage: 'Sage',
    blueberry: 'Blueberry',
    plum: 'Plum',
    rose: 'Rose',
  },
};

// Same shape as English with any text: a missing or extra key in another language is a type error
type Widen<T> = T extends string
  ? string
  : T extends readonly string[]
    ? string[]
    : { [K in keyof T]: Widen<T[K]> };
export type Dictionary = Widen<typeof en>;
