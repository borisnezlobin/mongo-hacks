import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { UserPlusIcon } from 'phosphor-react-native';
import type { Utterance } from '../../../shared/contracts';
import { AppText } from './app-text';
import { Avatar } from './avatar';
import { colors, radii, spacing } from '../constants/theme';
import { displayName, isUnnamed, type PersonRecord } from '../lib/store';

interface UtteranceRowProps {
  utterance: Utterance;
  person?: PersonRecord;
  /** False when the previous row is from the same speaker, Slack-style grouping. */
  showHeader: boolean;
  /** The server has heard this voice but has not finished working out whose it is. */
  attributing?: boolean;
  onPressPerson?(): void;
  onName?(): void;
  /** Receives where the text sits on screen, so a menu can open against it. */
  onLongPress?(anchor: { x: number; y: number; width: number; height: number }): void;
}

const AVATAR_SIZE = 36;
const GUTTER = AVATAR_SIZE + spacing.md;

/**
 * Slack shape: rounded-square avatar in a fixed left gutter, bold name and timestamp on
 * one line, message text flush beneath it. No bubbles — consecutive turns from the same
 * speaker drop the header and hang under the same gutter.
 *
 * A re-label changes who a row belongs to after it is already on screen. The row never
 * unmounts, only the identity crossfades, so it reads as a correction rather than a flicker.
 */
export function UtteranceRow({
  utterance,
  person,
  showHeader,
  attributing = false,
  onPressPerson,
  onName,
  onLongPress,
}: UtteranceRowProps) {
  const bodyRef = useRef<View>(null);
  const identityFade = useRef(new Animated.Value(1)).current;
  const highlight = useRef(new Animated.Value(0)).current;
  const previousPersonId = useRef(utterance.person_id);

  useEffect(() => {
    if (previousPersonId.current === utterance.person_id) return;
    previousPersonId.current = utterance.person_id;
    Animated.parallel([
      Animated.sequence([
        Animated.timing(identityFade, { toValue: 0, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(identityFade, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(highlight, { toValue: 1, duration: 180, useNativeDriver: false }),
        Animated.timing(highlight, { toValue: 0, duration: 900, delay: 250, useNativeDriver: false }),
      ]),
    ]).start();
  }, [utterance.person_id, identityFade, highlight]);

  const unnamed = !person || isUnnamed(person);
  const pending = attributing && !person;

  // A slow breath rather than a spinner: the row is already readable, and only
  // the name is provisional. Anything busier would draw the eye away from the
  // words, which are the part that arrived on time.
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    if (!pending) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pending, pulse]);

  const backgroundColor = highlight.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(0,0,0,0)', colors.liveSoft],
  });

  return (
    <Animated.View style={[styles.row, showHeader && styles.rowSpaced, { backgroundColor }]}>
      <View style={styles.gutter}>
        {showHeader ? (
        <Animated.View style={{ opacity: identityFade }}>
          <Pressable onPress={onPressPerson} accessibilityLabel={displayName(person)}>
            {/* Seed falls through voiceprint then person then utterance, so two speakers
                Amelia has not resolved yet never collide on the same colour. */}
            <Avatar
              person={person}
              seed={utterance.voiceprint_id ?? utterance.person_id ?? utterance._id}
              size={AVATAR_SIZE}
              shape="rounded"
            />
          </Pressable>
        </Animated.View>
        ) : null}
      </View>

      <View style={styles.column}>
        {showHeader ? (
          <Animated.View style={[styles.header, { opacity: identityFade }]}>
            {pending ? (
              <Animated.View style={{ opacity: pulse }}>
                <AppText variant="bodyStrong" color={colors.inkMuted} style={styles.name}>
                  Attributing…
                </AppText>
              </Animated.View>
            ) : (
              <Pressable onPress={unnamed && onName ? onName : onPressPerson} style={styles.nameRow}>
                <AppText
                  variant="bodyStrong"
                  color={unnamed ? colors.accent : colors.ink}
                  style={styles.name}
                >
                  {displayName(person)}
                </AppText>
                {unnamed && onName ? <UserPlusIcon size={13} color={colors.accent} weight="bold" /> : null}
              </Pressable>
            )}
            <AppText variant="caption">{formatOffset(utterance.start_ms)}</AppText>
          </Animated.View>
        ) : null}

        {/* Measured in window coordinates on press, so the menu can leave the
            message exactly where it already is rather than re-describing it. */}
        <View ref={bodyRef} collapsable={false}>
          <Pressable
            onLongPress={() => {
              if (!onLongPress) return;
              bodyRef.current?.measureInWindow((x, y, width, height) =>
                onLongPress({ x, y, width, height }));
            }}
            delayLongPress={280}
            disabled={!onLongPress}
          >
            {({ pressed }) => (
              <AppText
                variant="body"
                color={utterance.is_final ? colors.ink : colors.inkMuted}
                style={pressed && onLongPress ? styles.pressed : undefined}
              >
                {utterance.text}
                {utterance.is_final ? '' : '…'}
              </AppText>
            )}
          </Pressable>
        </View>

      </View>
    </Animated.View>
  );
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    marginHorizontal: -spacing.sm,
    borderRadius: 6,
  },
  rowSpaced: { marginTop: spacing.lg },
  gutter: { width: AVATAR_SIZE, alignItems: 'center' },
  column: { flex: 1, gap: 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 20 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  name: { fontFamily: 'Manrope_700Bold' },
  nameAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
  pressed: { opacity: 0.65 },
});
