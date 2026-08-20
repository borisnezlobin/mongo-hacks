import { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { MicrophoneIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, radii, spacing } from '../constants/theme';
import { formatClock } from '../lib/format';
import type { RecordingControls } from '../../audio/useAudioCapture';
import { isRecordingActive, recordingLabel } from '../state/recording';

function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const interval = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [active]);
  return seconds;
}

/** Five bars breathing at different rates — enough motion to read as live across a table. */
const LiveWaveform = memo(function LiveWaveform({ tint }: { tint: string }) {
  const bars = useRef([0, 1, 2, 3, 4].map(() => new Animated.Value(0.35))).current;

  useEffect(() => {
    const animations = bars.map((bar, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(bar, { toValue: 1, duration: 320 + index * 90, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
          Animated.timing(bar, { toValue: 0.3, duration: 300 + index * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        ]),
      ),
    );
    for (const animation of animations) animation.start();
    return () => {
      for (const animation of animations) animation.stop();
    };
  }, [bars]);

  return (
    <View style={styles.waveform}>
      {bars.map((bar, index) => (
        <Animated.View
          key={index}
          style={[
            styles.waveformBar,
            { backgroundColor: tint, height: bar.interpolate({ inputRange: [0, 1], outputRange: [4, 16] }) },
          ]}
        />
      ))}
    </View>
  );
});

const BUTTON_SIZE = 76;

/**
 * One circular control that squishes as it swaps glyphs, so record and stop read as the
 * same object changing state rather than two different buttons.
 */
const RecordButton = memo(function RecordButton({
  streaming,
  busy,
  failed,
  onPress,
}: {
  streaming: boolean;
  busy: boolean;
  failed: boolean;
  onPress(): void;
}) {
  const morph = useRef(new Animated.Value(streaming ? 1 : 0)).current;
  const squish = useRef(new Animated.Value(0)).current;
  const firstRun = useRef(true);

  useEffect(() => {
    const transition = Animated.timing(morph, {
      toValue: streaming ? 1 : 0,
      duration: 260,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    });
    if (firstRun.current) {
      firstRun.current = false;
      transition.start();
      return;
    }
    Animated.parallel([
      transition,
      Animated.sequence([
        Animated.timing(squish, { toValue: 1, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.spring(squish, { toValue: 0, friction: 4, tension: 90, useNativeDriver: true }),
      ]),
    ]).start();
  }, [streaming, morph, squish]);

  const scale = squish.interpolate({ inputRange: [0, 1], outputRange: [1, 0.88] });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={streaming ? 'Stop listening' : 'Start listening'}
      onPress={onPress}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}
    >
      <Animated.View
        style={[styles.recordButton, failed && styles.recordButtonFailed, { transform: [{ scale }] }]}
      >
        {busy ? (
          <ActivityIndicator color={colors.inkInverse} />
        ) : (
          <>
            <Animated.View
              style={[styles.glyph, { opacity: morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}
            >
              <MicrophoneIcon size={32} color={colors.inkInverse} weight="fill" />
            </Animated.View>
            <Animated.View
              style={[
                styles.glyph,
                {
                  opacity: morph,
                  transform: [{ scale: morph.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }],
                },
              ]}
            >
              <View style={styles.stopSquare} />
            </Animated.View>
          </>
        )}
      </Animated.View>
    </Pressable>
  );
});

interface RecordingBarProps {
  recording: RecordingControls;
  bottomOffset: number;
}

/**
 * Every state the machine can be in has a sentence here, including reconnecting — which
 * previously had no representation at all because there was no reconnect.
 *
 * The button is never disabled while "connecting": a connect that hangs used to leave the
 * only control on screen dead, with no way to give up.
 */
export function RecordingBar({ recording, bottomOffset }: RecordingBarProps) {
  const { state } = recording;
  const active = isRecordingActive(state) || state.status === 'stopping';
  const streaming = state.status === 'streaming';
  const reconnecting = state.status === 'reconnecting';
  const failed = state.status === 'error';
  const elapsed = useElapsedSeconds(streaming || reconnecting);

  const caption = failed
    ? state.error?.message ?? 'Something went wrong. Tap to try again.'
    : reconnecting
      ? `Reconnecting — holding ${state.bufferedFrames} ${state.bufferedFrames === 1 ? 'frame' : 'frames'} of audio`
      : streaming
        ? formatClock(elapsed)
        : recordingLabel(state);

  const press = () => {
    // During the stop grace the session is already finished, so a tap is a request to
    // start a new one — which is also what cancels the grace.
    if (isRecordingActive(state)) recording.stop();
    else void recording.start();
  };

  return (
    <View style={[styles.wrapper, { bottom: bottomOffset }]} pointerEvents="box-none">
      <View style={styles.column}>
        {streaming || reconnecting ? (
          <LiveWaveform tint={reconnecting ? colors.inkFaint : colors.live} />
        ) : null}
        <RecordButton
          streaming={active}
          busy={state.status === 'requesting-permission'}
          failed={failed}
          onPress={press}
        />
        {caption ? (
          <View style={styles.copy}>
            <AppText
              variant="caption"
              align="center"
              color={failed ? colors.live : streaming ? colors.ink : colors.inkMuted}
              numberOfLines={2}
            >
              {caption}
            </AppText>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'absolute', left: spacing.xl, right: spacing.xl, alignItems: 'center' },
  column: { alignItems: 'center', gap: spacing.sm },
  recordButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: radii.pill,
    backgroundColor: colors.live,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.live,
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  recordButtonFailed: { backgroundColor: colors.inkFaint },
  glyph: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  stopSquare: { width: 24, height: 24, borderRadius: 6, backgroundColor: colors.inkInverse },
  pressed: { opacity: 0.85 },
  copy: { maxWidth: 300 },
  waveform: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 18 },
  waveformBar: { width: 3, borderRadius: radii.pill },
});
