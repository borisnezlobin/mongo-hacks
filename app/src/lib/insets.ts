import { Dimensions, Platform, StatusBar } from 'react-native';

/**
 * react-native-safe-area-context is a native module and the dev client is already built,
 * so insets are derived instead of measured. Phone-only by app.json, which keeps this honest.
 */
function hasHomeIndicator(): boolean {
  if (Platform.OS !== 'ios') return false;
  const { height, width } = Dimensions.get('window');
  return Math.max(height, width) >= 812;
}

export function getInsets(): { top: number; bottom: number } {
  if (Platform.OS === 'ios') {
    return { top: hasHomeIndicator() ? 59 : 20, bottom: hasHomeIndicator() ? 34 : 0 };
  }
  return { top: StatusBar.currentHeight ?? 24, bottom: 0 };
}
