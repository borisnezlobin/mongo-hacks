import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';
import { ChatCircleIcon, SpeakerHighIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { GlassSurface } from './ui';
import { colors, spacing } from '../constants/theme';
import type { AmeliaTurn } from '../lib/store';

interface AmeliaPillProps {
  hidden?: boolean;
  turn: AmeliaTurn | null;
  bottomOffset: number;
  onPress?(): void;
  /** Press-and-hold manual summon — the stage fallback when the voice gate fails. */
  onLongPress?(): void;
}

/**
 * Always present so the press-and-hold summon is discoverable even before the
 * first turn. With an active turn it shows the latest step and a tap opens the
 * transcript; idle it reads as a quiet "Ask Amelia" affordance.
 */
export function AmeliaPill({ hidden, turn, bottomOffset, onPress, onLongPress }: AmeliaPillProps) {
  const entrance = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  const latest = turn
    ? turn.reply ?? turn.steps[turn.steps.length - 1]?.message ?? 'Thinking'
    : 'Ask Amelia';
  const speaking = Boolean(turn?.reply);

  // Home carries its own ask field, so the idle pill there is a duplicate affordance that
  // also lands on top of the record button.
  if (hidden) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        {
          bottom: bottomOffset,
          opacity: entrance,
          transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        },
      ]}
    >
      <GlassSurface style={styles.pill}>
        <Pressable
          style={styles.inner}
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={350}
          accessibilityRole="button"
          accessibilityLabel="Ask Amelia. Long press to type a request."
        >
          {speaking
            ? <SpeakerHighIcon size={18} color={colors.accent} weight="fill" />
            : <ChatCircleIcon size={18} color={colors.accent} weight={turn ? 'fill' : 'regular'} />}
          <AppText variant="bodyStrong" numberOfLines={1} style={styles.text} color={turn ? colors.ink : colors.inkMuted}>
            {latest}
          </AppText>
        </Pressable>
      </GlassSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'absolute', left: spacing.xl, right: spacing.xl },
  pill: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  inner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { flex: 1 },
});
