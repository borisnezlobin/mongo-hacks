import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, View } from 'react-native';
import { SpeakerHighIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, radii, spacing } from '../constants/theme';
import type { AmeliaTurn } from '../lib/store';

/**
 * Amelia is one message in the transcript, not a stream of them. Steps accumulate inside
 * it and the spoken answer replaces the trace when it lands.
 */
export function AmeliaMessage({ turn }: { turn: AmeliaTurn }) {
  const entrance = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  const answered = Boolean(turn.reply);
  const isContextUpdate = turn.kind === 'context_update';

  return (
    <Animated.View
      style={[
        styles.row,
        {
          opacity: entrance,
          transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        },
      ]}
    >
      {/* A monogram rather than an icon. Amelia's turns sit in the same gutter
          as everyone else's avatar, so the mark should read as a participant. */}
      <View style={styles.mark}>
        <AppText variant="bodyStrong" color={colors.accent}>A</AppText>
      </View>

      <View style={styles.column}>
        <View style={styles.header}>
          <AppText variant="bodyStrong" color={colors.accent}>
            {isContextUpdate ? 'Amelia noticed a change' : 'Amelia'}
          </AppText>
          {!answered ? <ActivityIndicator size="small" color={colors.inkFaint} /> : null}
        </View>

        <View style={styles.bubble}>
          {turn.steps.map((step, index) => (
            <StepLine
              key={`${step.step}-${index}`}
              message={step.message}
              faded={answered || index < turn.steps.length - 1}
            />
          ))}

          {answered ? (
            <View style={styles.reply}>
              <AppText variant="body">{turn.reply}</AppText>
              {turn.audio_url ? (
                <View style={styles.spoken}>
                  <SpeakerHighIcon size={13} color={colors.accent} weight="fill" />
                  <AppText variant="caption" color={colors.accent}>Spoken aloud</AppText>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

function StepLine({ message, faded }: { message: string; faded: boolean }) {
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, [fade]);

  return (
    <Animated.View style={{ opacity: fade }}>
      <AppText variant="caption" color={faded ? colors.inkFaint : colors.inkMuted}>{message}</AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  column: { flex: 1, gap: spacing.xs },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bubble: { gap: 3 },
  reply: { marginTop: spacing.sm, gap: spacing.sm },
  spoken: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
