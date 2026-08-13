import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';
import { SparkleIcon, SpeakerHighIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { GlassSurface } from './ui';
import { colors, spacing } from '../constants/theme';
import type { AmeliaTurn } from '../lib/store';

interface AmeliaPillProps {
  turn: AmeliaTurn | null;
  bottomOffset: number;
  onPress?(): void;
}

/** One pill, one turn. It updates in place rather than stacking status lines. */
export function AmeliaPill({ turn, bottomOffset, onPress }: AmeliaPillProps) {
  const entrance = useRef(new Animated.Value(0)).current;
  const visible = Boolean(turn);

  useEffect(() => {
    Animated.timing(entrance, {
      toValue: visible ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, entrance]);

  if (!turn) return null;

  const latest = turn.reply ?? turn.steps[turn.steps.length - 1]?.message ?? 'Thinking';
  const speaking = Boolean(turn.reply);

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
        <Pressable style={styles.inner} onPress={onPress} accessibilityRole="button">
          {speaking
            ? <SpeakerHighIcon size={18} color={colors.accent} weight="fill" />
            : <SparkleIcon size={18} color={colors.accent} weight="fill" />}
          <AppText variant="bodyStrong" numberOfLines={1} style={styles.text}>
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
