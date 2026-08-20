import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CheckIcon, XIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, radii, spacing } from '../constants/theme';
import type { NameSuggestion } from '../state/reducer';
import { useActions } from '../state/store';

interface NameSuggestionCardProps {
  suggestion: NameSuggestion;
  /** Confirming goes through the ordinary naming path, which is what enrolls the voice. */
  onConfirm(name: string): void;
}

/**
 * A name the room said, offered against the voice it was said to.
 *
 * Deliberately quiet and inline rather than a sheet or an alert: this fires while the
 * owner is mid-conversation, and a modal over the live transcript would interrupt the
 * thing being transcribed.
 *
 * The evidence is the point. "Is this Josh?" is a guess nobody can evaluate; the actual
 * sentence is one they can judge in a second without replaying anything. The copy never
 * states the name as fact — it reports what was heard.
 */
export const NameSuggestionCard = memo(function NameSuggestionCard({
  suggestion,
  onConfirm,
}: NameSuggestionCardProps) {
  const actions = useActions();

  return (
    <View style={styles.card}>
      <View style={styles.copy}>
        <AppText variant="caption" color={colors.inkMuted}>
          Heard the name {suggestion.name} here. Is this them?
        </AppText>
        <AppText variant="caption" color={colors.inkFaint} numberOfLines={2}>
          “{suggestion.evidence}”
        </AppText>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => onConfirm(suggestion.name)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Yes, this is ${suggestion.name}`}
          style={({ pressed }) => [styles.confirm, pressed && styles.pressed]}
        >
          <CheckIcon size={13} color={colors.inkInverse} weight="bold" />
          <AppText variant="caption" color={colors.inkInverse}>Yes, {suggestion.name}</AppText>
        </Pressable>
        <Pressable
          onPress={() => actions.dismissNameSuggestion(suggestion.voice_id, suggestion.name)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Not them"
          style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
        >
          <XIcon size={13} color={colors.inkFaint} />
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    marginTop: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.surfaceMuted,
  },
  copy: { gap: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  confirm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  dismiss: { padding: 6 },
  pressed: { opacity: 0.7 },
});
