import { useEffect } from 'react';
import { Canvas, Rect } from '@shopify/react-native-skia';
import { Easing, useDerivedValue, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

export const NATIVE_SMOKE_ENABLED = __DEV__ && process.env.EXPO_PUBLIC_NATIVE_SMOKE === '1';

/**
 * A 1x1 canvas whose only job is to fail loudly if Skia or the Reanimated worklet
 * runtime did not link into the dev client. Delete once a real ShardField renders.
 */
export function NativeSmoke() {
  const progress = useSharedValue(0);
  const color = useDerivedValue(() => (progress.value > 0.5 ? '#FF4A1C' : '#1B1918'));

  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 600, easing: Easing.linear }), -1, true);
  }, [progress]);

  return (
    <Canvas style={{ width: 1, height: 1 }}>
      <Rect x={0} y={0} width={1} height={1} color={color} />
    </Canvas>
  );
}
