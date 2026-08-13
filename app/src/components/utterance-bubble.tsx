import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { UserPlusIcon } from 'phosphor-react-native';
import type { Utterance } from '../../../shared/contracts';
import { AppText } from './app-text';
import { Avatar } from './avatar';
import { colors, radii, spacing } from '../constants/theme';
import { displayName, isUnnamed, type PersonRecord } from '../lib/store';

interface UtteranceBubbleProps {
  utterance: Utterance;
  person?: PersonRecord;
  isOwner: boolean;
  /** False when the previous bubble is from the same speaker, Slack-style grouping. */
  showHeader: boolean;
  onPressPerson?(): void;
  onName?(): void;
}

/**
 * A re-label changes who a bubble belongs to after it is already on screen. The row never
 * unmounts — only the identity crossfades — so the transcript reads as a correction rather
 * than a flicker.
 */
export function UtteranceBubble({
  utterance,
  person,
  isOwner,
  showHeader,
  onPressPerson,
  onName,
}: UtteranceBubbleProps) {
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
  const backgroundColor = highlight.interpolate({
    inputRange: [0, 1],
    outputRange: [isOwner ? colors.accentSoft : colors.surface, colors.liveSoft],
  });

  return (
    <View style={styles.row}>
      <Animated.View style={{ opacity: identityFade }}>
        {showHeader ? (
          <Pressable onPress={onPressPerson} accessibilityLabel={displayName(person)}>
            <Avatar person={person} seed={utterance.voiceprint_id} size={34} />
          </Pressable>
        ) : (
          <View style={styles.avatarSpacer} />
        )}
      </Animated.View>

      <View style={styles.column}>
        {showHeader ? (
          <Animated.View style={[styles.header, { opacity: identityFade }]}>
            <Pressable onPress={onPressPerson}>
              <AppText variant="bodyStrong" color={unnamed ? colors.inkMuted : colors.ink}>
                {displayName(person)}
              </AppText>
            </Pressable>
            <AppText variant="caption">{formatOffset(utterance.start_ms)}</AppText>
          </Animated.View>
        ) : null}

        <Animated.View style={[styles.bubble, { backgroundColor }, !utterance.is_final && styles.bubbleInterim]}>
          <AppText variant="body" color={utterance.is_final ? colors.ink : colors.inkMuted}>
            {utterance.text}
            {utterance.is_final ? '' : '…'}
          </AppText>
        </Animated.View>

        {unnamed && onName ? (
          <Pressable
            onPress={onName}
            style={({ pressed }) => [styles.nameAction, pressed && styles.pressed]}
            accessibilityLabel="Name this speaker"
          >
            <UserPlusIcon size={13} color={colors.accent} weight="bold" />
            <AppText variant="caption" color={colors.accent}>This is…</AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  avatarSpacer: { width: 34 },
  column: { flex: 1, gap: spacing.xs },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  bubble: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.bubble,
    borderTopLeftRadius: 4,
  },
  bubbleInterim: { backgroundColor: colors.canvasSunken },
  nameAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
  pressed: { opacity: 0.65 },
});
