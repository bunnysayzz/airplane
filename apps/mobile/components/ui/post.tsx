/**
 * MIT License
 *
 * Copyright (c) 2026 Khalid Abdi
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Post - a card carrying something somebody said, and what everyone did about it.
 *
 * Vendored from panel-ui/panelui (MIT, see above) and ADAPTED for Airplane:
 * - uniwind `className` props → React Native StyleSheet, driven by the app's
 *   own theme (`useTheme` / `useThemedStyles` in src/theme). uniwind cannot be
 *   installed here: it requires react-native >= 0.81 and this app pins 0.79.7.
 * - tailwind-variants `tv` slots → plain variant/size style maps (same shapes).
 * - react-native-reanimated count animations → static values. reanimated's
 *   babel plugin is not configured in this app, so animated values would warn
 *   at runtime; a views count that ticks up does not need the choreography.
 * - @hugeicons icons → the team's icon stack (@expo/vector-icons); the `icon`
 *   prop still takes a component, so `Post.Stat icon={EyeIcon}` reads the same.
 * - `Post.Media` (expo-linear-gradient scrim), `Post.Title`, `Post.Community`
 *   and `Post.Votes` were dropped with their subcomponents: v1 Airplane posts
 *   are text-only, there are no communities, and ranking is by views - voting
 *   arrows would contradict the product.
 *
 * What survives is the anatomy panelui is built around - the same
 * `Post.Header`, `Post.Body`, `Post.Footer` - so the compound reads exactly
 * like the original:
 *
 * ```tsx
 * <Post>
 *   <Post.Header>
 *     <Post.Author name="quiet fox·a3f9" handle="#tdr1v" timestamp="3m" />
 *     <Post.Action><Text>🌍 world</Text></Post.Action>
 *   </Post.Header>
 *   <Post.Body>mesh post body, #hashtags highlighted</Post.Body>
 *   <Post.Footer>
 *     <Post.Stat icon={EyeIcon} value={5874} />
 *   </Post.Footer>
 * </Post>
 * ```
 */
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text as RNText,
  type ImageSourcePropType,
  type ImageStyle,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { View } from 'react-native';
import { ThemeColors, useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { radii, space } from '../../src/theme/shape';

export type PostVariant = 'feed' | 'compact';
export type PostSize = 'default' | 'sm';

const PostContext = createContext<{ variant: PostVariant; size: PostSize }>({
  variant: 'feed',
  size: 'default',
});

function usePost() {
  return useContext(PostContext);
}

/* -------------------------------------------------------------------------- */
/* Styles - one factory per theme, matching the team's useThemedStyles pattern */
/* -------------------------------------------------------------------------- */

interface PostStyles {
  root: ViewStyle;
  header: ViewStyle;
  authorRow: ViewStyle;
  authorBlock: ViewStyle;
  authorLine: ViewStyle;
  name: TextStyle;
  meta: TextStyle;
  action: ViewStyle;
  bodyWrap: ViewStyle;
  bodyText: TextStyle;
  tagText: TextStyle;
  footer: ViewStyle;
  stat: ViewStyle;
  statLabel: TextStyle;
  avatar: ViewStyle;
  avatarImage: ImageStyle;
  avatarText: TextStyle;
}

const makeStyles = (colors: ThemeColors, variant: PostVariant, size: PostSize) => {
  const compact = variant === 'compact';
  const small = size === 'sm';
  return StyleSheet.create<PostStyles>({
    root: {
      width: '100%',
      overflow: 'hidden',
      borderRadius: compact ? radii.well : radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderColor,
      backgroundColor: colors.cardBackground,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: space.md,
      padding: compact ? 14 : space.lg,
      paddingBottom: compact ? space.sm : space.md,
    },
    authorRow: {
      minWidth: 0,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    avatar: {
      width: compact ? 28 : 36,
      height: compact ? 28 : 36,
      borderRadius: compact ? 14 : 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentSoft,
    },
    avatarText: {
      color: colors.accentText,
      fontSize: compact ? 11 : 13,
      fontWeight: '700',
    },
    avatarImage: {
      width: compact ? 28 : 36,
      height: compact ? 28 : 36,
      borderRadius: compact ? 14 : 18,
    },
    authorBlock: { minWidth: 0, flex: 1, gap: 2 },
    authorLine: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 24 },
    name: {
      color: colors.textPrimary,
      fontSize: small ? 14 : 15,
      lineHeight: small ? 18 : 20,
      fontWeight: '700',
      flexShrink: 1,
    },
    meta: {
      color: colors.textSecondary,
      fontSize: small ? 12 : 12.5,
      lineHeight: small ? 16 : 17,
      fontWeight: '600',
    },
    // As tall as the name's own line box, so the trailing slot lands on the
    // username's line rather than somewhere between the two lines of the
    // author block.
    action: { height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
    bodyWrap: {
      paddingHorizontal: compact ? 14 : space.lg,
      paddingBottom: compact ? 10 : space.md,
    },
    bodyText: {
      color: colors.textPrimary,
      fontSize: compact ? 14 : 15.5,
      lineHeight: compact ? 20 : 22.5,
    },
    tagText: { color: colors.accentText, fontWeight: '600' },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: compact ? 24 : 20,
      padding: compact ? 14 : space.lg,
      paddingTop: 0,
    },
    stat: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statLabel: {
      color: colors.textSecondary,
      fontSize: small ? 12 : 13,
      lineHeight: small ? 16 : 18,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
    },
  });
};

function usePostStyles(): PostStyles {
  const { variant, size } = usePost();
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors, variant, size), [colors, variant, size]);
}

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

export interface PostProps extends Omit<ViewProps, 'children' | 'style'> {
  style?: StyleProp<ViewStyle>;
  /** `feed` is the full card; `compact` tightens it for a dense timeline. */
  variant?: PostVariant;
  /** `sm` tightens the type for a card in a sidebar or a preview. */
  size?: PostSize;
  /** Opening the post itself. The parts inside keep their own presses. */
  onPress?: PressableProps['onPress'];
  children?: ReactNode;
}

const PostRoot = forwardRef<View, PostProps>(
  ({ style, variant = 'feed', size = 'default', onPress, children, ...props }, ref) => {
    const styles = useThemedStyles((colors) => makeStyles(colors, variant, size));
    const context = useMemo(() => ({ variant, size }), [variant, size]);

    const body = (
      <PostContext.Provider value={context}>{children}</PostContext.Provider>
    );

    if (!onPress) {
      return (
        <View ref={ref} {...props} style={[styles.root, style]}>
          {body}
        </View>
      );
    }

    return (
      <Pressable
        ref={ref}
        {...props}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.root, style, pressed && { opacity: 0.9 }]}
      >
        {body}
      </Pressable>
    );
  }
);
PostRoot.displayName = 'Post';

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

export interface PostHeaderProps extends Omit<ViewProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/**
 * The author row. `Post.Action` is pulled to the trailing edge, so the
 * trailing slot stays in the corner as a long display name wraps rather than
 * riding down with it.
 */
const PostHeader = forwardRef<View, PostHeaderProps>(
  ({ style, children, ...props }, ref) => {
    const styles = usePostStyles();

    const content: ReactNode[] = [];
    const actions: ReactNode[] = [];
    for (const child of Array.isArray(children) ? children : [children]) {
      if (isType(child, PostAction)) actions.push(child);
      else content.push(child);
    }

    return (
      <View ref={ref} style={[styles.header, style]} {...props}>
        {content}
        {actions}
      </View>
    );
  }
);
PostHeader.displayName = 'Post.Header';

function isType(child: ReactNode, type: unknown): boolean {
  return (
    typeof child === 'object' &&
    child !== null &&
    'type' in child &&
    (child as { type?: unknown }).type === type
  );
}

export interface PostAuthorProps extends Omit<ViewProps, 'children' | 'style'> {
  style?: StyleProp<ViewStyle>;
  /** Display name - in Airplane, a short pseudonym like "quiet fox·a3f9". */
  name: string;
  /** Origin tag, e.g. "#tdr1v". Shown under the name in `feed`. */
  handle?: string;
  avatar?: ImageSourcePropType;
  /** Initials behind a missing or broken avatar. */
  fallback?: string;
  /** "3m" - whatever the caller wants to call the time. */
  timestamp?: ReactNode;
  children?: ReactNode;
}

/** Who posted it. Anonymous by product: no verification rosette exists here. */
const PostAuthor = forwardRef<View, PostAuthorProps>(
  (
    { style, name, handle, avatar, fallback, timestamp, children, ...props },
    ref
  ) => {
    const styles = usePostStyles();
    const inline = usePost().variant === 'compact';

    const metaLine = [handle, typeof timestamp === 'string' ? timestamp : undefined]
      .filter(Boolean)
      .join(' · ');

    return (
      <View ref={ref} style={styles.authorRow} {...props}>
        {avatar ? (
          <Image source={avatar} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatar}>
            <RNText style={styles.avatarText}>{fallback ?? initials(name)}</RNText>
          </View>
        )}
        <View style={[styles.authorBlock, style]}>
          <View style={styles.authorLine}>
            <RNText numberOfLines={1} style={styles.name}>
              {name}
            </RNText>
            {inline && handle ? (
              <RNText numberOfLines={1} style={styles.meta}>
                {handle}
              </RNText>
            ) : null}
            {inline && timestamp !== undefined ? (
              <RNText numberOfLines={1} style={styles.meta}>
                {typeof timestamp === 'string' ? ` · ${timestamp}` : timestamp}
              </RNText>
            ) : null}
          </View>
          {!inline && metaLine ? (
            <RNText numberOfLines={1} style={styles.meta}>
              {metaLine}
            </RNText>
          ) : null}
          {!inline && timestamp !== undefined && typeof timestamp !== 'string'
            ? timestamp
            : null}
          {children}
        </View>
      </View>
    );
  }
);
PostAuthor.displayName = 'Post.Author';

/** First letters of the first two words - enough to tell two people apart. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

export interface PostActionProps extends Omit<ViewProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/** The header's trailing slot - a badge, a menu, a "world" pill. */
const PostAction = forwardRef<View, PostActionProps>(
  ({ style, children, ...props }, ref) => {
    const styles = usePostStyles();
    return (
      <View ref={ref} style={[styles.action, style]} {...props}>
        {children}
      </View>
    );
  }
);
PostAction.displayName = 'Post.Action';

/* -------------------------------------------------------------------------- */
/* Body                                                                       */
/* -------------------------------------------------------------------------- */

export interface PostBodyProps extends Omit<ViewProps, 'children' | 'style'> {
  style?: StyleProp<ViewStyle>;
  /** How many lines before it is cut off. Unlimited by default. */
  numberOfLines?: number;
  /** Called with the tag, without its `#`. Makes hashtags pressable. */
  onTagPress?: (tag: string) => void;
  /** Called with the handle, without its `@`. */
  onMentionPress?: (handle: string) => void;
  children?: ReactNode;
}

/**
 * What was written.
 *
 * Hashtags and mentions inside a string child are picked out and coloured.
 * They are found in the text rather than declared, because a post body arrives
 * as one string from wherever it was typed - asking the caller to pre-split it
 * would mean every caller writing the same tokeniser.
 *
 * A non-string child is left entirely alone: it has already been laid out by
 * someone who knew more than we do.
 */
const PostBody = forwardRef<View, PostBodyProps>(
  ({ style, numberOfLines, onTagPress, onMentionPress, children, ...props }, ref) => {
    const styles = usePostStyles();

    if (typeof children !== 'string') {
      return (
        <View ref={ref} style={[styles.bodyWrap, style]} {...props}>
          {children}
        </View>
      );
    }

    return (
      <View ref={ref} style={[styles.bodyWrap, style]} {...props}>
        <RNText numberOfLines={numberOfLines} style={styles.bodyText}>
          {tokenize(children).map((token, index) =>
            token.kind === 'text' ? (
              token.value
            ) : (
              <RNText
                key={index}
                style={styles.tagText}
                onPress={
                  token.kind === 'tag'
                    ? onTagPress && (() => onTagPress(token.value.slice(1)))
                    : onMentionPress && (() => onMentionPress(token.value.slice(1)))
                }
              >
                {token.value}
              </RNText>
            )
          )}
        </RNText>
      </View>
    );
  }
);
PostBody.displayName = 'Post.Body';

interface Token {
  kind: 'text' | 'tag' | 'mention';
  value: string;
}

/**
 * Splits a body into plain runs, hashtags and mentions.
 *
 * The tag pattern stops at whitespace and at punctuation that ends a sentence,
 * so "#mesh." highlights the tag and leaves the full stop alone - the naive
 * `\S+` swallows it and the sentence loses its ending.
 */
function tokenize(text: string): Token[] {
  const pattern = /[#@][\w-]+/g;
  const tokens: Token[] = [];
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) tokens.push({ kind: 'text', value: text.slice(last, start) });
    tokens.push({
      kind: match[0].startsWith('#') ? 'tag' : 'mention',
      value: match[0],
    });
    last = start + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) });
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                     */
/* -------------------------------------------------------------------------- */

export interface PostFooterProps extends Omit<ViewProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/** The row of counts and controls under the post. */
const PostFooter = forwardRef<View, PostFooterProps>(
  ({ style, children, ...props }, ref) => {
    const styles = usePostStyles();
    return (
      <View ref={ref} style={[styles.footer, style]} {...props}>
        {children}
      </View>
    );
  }
);
PostFooter.displayName = 'Post.Footer';

/** Which theme colour "lit" is. No success tone exists in the theme, so the accent covers it. */
const statTone: Record<'default' | 'like' | 'save' | 'repost', keyof ThemeColors> = {
  default: 'accentText',
  like: 'dangerColor',
  save: 'accentText',
  repost: 'accentText',
};

export interface PostStatProps extends Omit<PressableProps, 'children' | 'style'> {
  style?: StyleProp<ViewStyle>;
  /** The icon component itself, not an element - it is re-rendered on toggle. */
  icon?: ComponentType<{ size?: number; color?: string; filled?: boolean }>;
  /** The number, or a word where a number would be meaningless ("Save"). */
  value?: ReactNode;
  /** Lit, and filled. */
  active?: boolean;
  /** Which colour "lit" is. */
  tone?: 'default' | 'like' | 'save' | 'repost';
  /** Pushes this stat and everything after it to the trailing edge. */
  align?: 'start' | 'end';
  children?: ReactNode;
}

/**
 * One count in the footer, and the control that changes it.
 *
 * panelui animates the value when it changes; this adaptation renders it
 * statically - reanimated's babel plugin is not configured in this app, so
 * animated values would only warn at runtime. The number is still the point:
 * in Airplane the views stat is the hero of the card, not a toggle.
 */
const PostStat = forwardRef<View, PostStatProps>(
  (
    {
      style,
      icon: Icon,
      value,
      active = false,
      tone = 'default',
      align = 'start',
      onPress,
      children,
      ...props
    },
    ref
  ) => {
    const styles = usePostStyles();
    const { colors } = useTheme();
    const size = usePost().variant === 'compact' ? 15 : 17;

    const colour = active ? colors[statTone[tone]] : colors.textSecondary;

    const inner = (
      <>
        {Icon ? <Icon size={size} color={colour} filled={active} /> : null}
        {value !== undefined ? (
          <RNText style={[styles.statLabel, active && { color: colour }]}>
            {value}
          </RNText>
        ) : null}
        {children}
      </>
    );

    const statStyle: ViewStyle[] = [
      styles.stat,
      align === 'end' ? { marginLeft: 'auto' } : {},
    ];

    if (!onPress) {
      return (
        <View ref={ref} style={[...statStyle, style]}>
          {inner}
        </View>
      );
    }

    return (
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        // The row is dense, so the targets overlap their own boxes rather than
        // being spaced far enough apart to be hit.
        hitSlop={10}
        onPress={onPress}
        style={[...statStyle, style]}
        {...props}
      >
        {inner}
      </Pressable>
    );
  }
);
PostStat.displayName = 'Post.Stat';

export const Post = Object.assign(PostRoot, {
  Header: PostHeader,
  Author: PostAuthor,
  Action: PostAction,
  Body: PostBody,
  Footer: PostFooter,
  Stat: PostStat,
});
