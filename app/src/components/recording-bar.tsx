import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { MicrophoneIcon, StopCircleIcon } from 'phosphor-react-native';
import type { AudioUplink } from '../../../shared/contracts';
import { AppText } from './app-text';
import { GlassSurface } from './ui';
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

/** Five bars breathing at different rates — enough motion to read as live from across a table. */
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
          style={[
            styles.waveformBar,
            { height: bar.interpolate({ inputRange: [0, 1], outputRange: [5, 20] }) },
          ]}
        />
      ))}
    </View>
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
  const elapsed = useElapsedSeconds(streaming);

  const label = streaming ? formatClock(elapsed) : connecting ? 'Connecting' : 'Start listening';
  const helper = streaming ? 'Amelia is listening' : connecting ? 'Opening the mic' : 'Tap to capture this conversation';

  return (
    <View style={[styles.wrapper, { bottom: bottomOffset }]} pointerEvents="box-none">
      <GlassSurface style={[styles.bar, streaming && styles.barLive]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={streaming ? 'Stop listening' : 'Start listening'}
          onPress={() => {
            // start()/stop() reject when the uplink socket cannot reach the server. The
            // hook already reflects that in its own state, so swallow it here rather than
            // letting it surface as an unhandled rejection redbox.
            const action = streaming ? uplink.stop() : uplink.start();
            void Promise.resolve(action).catch(() => {});
          }}
          disabled={connecting}
          style={({ pressed }) => [styles.trigger, streaming && styles.triggerLive, pressed && styles.pressed]}
        >
          {streaming
            ? <StopCircleIcon size={24} color={colors.inkInverse} weight="fill" />
            : <MicrophoneIcon size={22} color={colors.inkInverse} weight="fill" />}
        </Pressable>

        <Pressable style={styles.copy} onPress={onOpenLive} disabled={!streaming}>
          <AppText variant="bodyStrong" color={streaming ? colors.live : colors.ink}>{label}</AppText>
          <AppText variant="caption">{helper}</AppText>
        </Pressable>

        {streaming ? <LiveWaveform /> : null}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'absolute', left: spacing.xl, right: spacing.xl },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: spacing.lg,
  },
  barLive: { backgroundColor: colors.surface },
  trigger: {
    width: 46,
    height: 46,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.ink,
  },
  triggerLive: { backgroundColor: colors.live },
  pressed: { opacity: 0.75 },
  copy: { flex: 1, gap: 1 },
  waveform: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 22 },
  waveformBar: { width: 3, borderRadius: radii.pill, backgroundColor: colors.live },
});
