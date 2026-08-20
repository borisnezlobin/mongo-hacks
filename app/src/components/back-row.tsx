import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { CaretLeftIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, layout, spacing } from '../constants/theme';

/** Defined once. The transcript and the profile each had their own identical copy. */
export const BackRow = memo(function BackRow({ onPress }: { onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={styles.row} accessibilityLabel="Back" hitSlop={8}>
      <CaretLeftIcon size={20} color={colors.ink} />
      <AppText variant="bodyStrong">Back</AppText>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.sm,
  },
});
