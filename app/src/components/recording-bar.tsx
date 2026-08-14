import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { MicrophoneIcon } from 'phosphor-react-native';
import type { AudioUplink } from '../../../shared/contracts';
import { AppText } from './app-text';
import { colors, radii, spacing } from '../constants/theme';

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

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Five bars breathing at different rates — enough motion to read as live across a table. */
function LiveWaveform() {
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
          style={[styles.waveformBar, { height: bar.interpolate({ inputRange: [0, 1], outputRange: [4, 16] }) }]}
        />
      ))}
    </View>
  );
}

const BUTTON_SIZE = 76;

/**
 * One circular control that squishes as it swaps glyphs, so record and stop read as the
 * same object changing state rather than two different buttons. The mic and the stop
 * square share a slot and cross-fade, so nothing jumps position.
 */
function RecordButton({
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
      disabled={busy}
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
}

interface RecordingBarProps {
  uplink: AudioUplink;
  bottomOffset: number;
  onOpenLive?(): void;
}

export function RecordingBar({ uplink, bottomOffset, onOpenLive }: RecordingBarProps) {
  const streaming = uplink.state === 'streaming';
  const connecting = uplink.state === 'connecting';
  const failed = uplink.state === 'error';
  const elapsed = useElapsedSeconds(streaming);
  const [failure, setFailure] = useState<string | null>(null);

  const label = streaming
    ? formatClock(elapsed)
    : connecting
      ? 'Connecting'
      : failed
        ? "Couldn't start"
        : 'Start listening';

  // A failed start used to fall through to the idle copy, so the control just flickered
  // and said "Start listening" again. Showing the reason turns a mystery into an action.
  const helper = streaming
    ? 'Amelia is listening — tap to see the transcript'
    : connecting
      ? 'Opening the mic'
      : failed
        ? (failure ?? 'Tap to try again')
        : 'Tap to capture this conversation';

  const press = () => {
    if (streaming) {
      void Promise.resolve(uplink.stop()).catch(() => {});
      return;
    }
    setFailure(null);
    void Promise.resolve(uplink.start()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setFailure(
        /permission/i.test(message)
          ? 'Microphone permission denied. Enable it in Settings › Amelia.'
          : message,
      );
    });
  };

  return (
    <View style={[styles.wrapper, { bottom: bottomOffset }]} pointerEvents="box-none">
      <View style={styles.column}>
        {streaming ? <LiveWaveform /> : null}
        <RecordButton streaming={streaming} busy={connecting} failed={failed} onPress={press} />
        {/* No caption under the mic: the button's colour and glyph already say whether
            Amelia is listening, and the label crowded the transcript beneath it. The
            failure reason is the one thing worth words, so it alone still renders. */}
        {failed ? (
          <Pressable onPress={onOpenLive} disabled style={styles.copy}>
            <AppText variant="caption" align="center" color={colors.live} numberOfLines={2}>
              {failure ?? "Couldn't start — tap to try again"}
            </AppText>
          </Pressable>
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
  copy: { gap: 1, maxWidth: 300 },
  waveform: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 18 },
  waveformBar: { width: 3, borderRadius: radii.pill, backgroundColor: colors.live },
});
