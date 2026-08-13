import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Measured insets, so the tab bar and floating bars sit correctly on every device. */
export function useInsets(): { top: number; bottom: number } {
  const insets = useSafeAreaInsets();
  return { top: insets.top, bottom: insets.bottom };
}
