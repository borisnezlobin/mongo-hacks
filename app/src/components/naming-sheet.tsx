import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { AppText } from './app-text';
import { Avatar } from './avatar';
import { Sheet, sheetStyles } from './sheet';
import { Button } from './ui';
import { colors, radii, spacing } from '../constants/theme';
import type { PersonRecord } from '../state/reducer';

interface NamingSheetProps {
  person: PersonRecord | null;
  onCancel(): void;
  onSave(name: string, relationship: string, isOwner?: boolean): void;
  quickNames?: string[];
}

/**
 * The naming moment is one of the two delight beats in the demo, so it stays a single
 * field with the face already visible above it — you type a name onto a voice you can see.
 */
export function NamingSheet({ person, onCancel, onSave, quickNames = [] }: NamingSheetProps) {
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');

  useEffect(() => {
    setName('');
    setRelationship('');
  }, [person?._id]);

  const trimmed = name.trim();

  return (
    <Sheet
      visible={Boolean(person)}
      title="Who is this?"
      body="Everything this voice already said gets filed under the name you give it."
      leading={<Avatar person={person ?? undefined} size={52} />}
      onDismiss={onCancel}
    >
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor={colors.inkFaint}
        autoFocus
        autoCapitalize="words"
        style={sheetStyles.input}
        returnKeyType="done"
        onSubmitEditing={() => trimmed && onSave(trimmed, relationship)}
      />
      <TextInput
        value={relationship}
        onChangeText={setRelationship}
        placeholder="How you know them (optional)"
        placeholderTextColor={colors.inkFaint}
        style={sheetStyles.input}
      />

      {quickNames.length > 0 ? (
        <View style={styles.quickRow}>
          {quickNames.map((suggestion) => (
            <Pressable
              key={suggestion}
              onPress={() => setName(suggestion)}
              style={({ pressed }) => [styles.quickChip, pressed && styles.pressed]}
            >
              <AppText variant="caption" color={colors.accent}>{suggestion}</AppText>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* The owner's own voice shows up as just another unknown speaker, and naming it
          after yourself is not the same as claiming it — this marks it as you. */}
      <Pressable
        onPress={() => onSave(trimmed || 'Me', relationship, true)}
        style={({ pressed }) => [styles.ownerAction, pressed && styles.pressed]}
      >
        <AppText variant="bodyStrong" color={colors.accent}>This is me</AppText>
        <AppText variant="caption">Mark this voice as yours</AppText>
      </Pressable>

      <View style={sheetStyles.actions}>
        <Button label="Not now" variant="quiet" onPress={onCancel} style={sheetStyles.action} />
        <Button
          label="Save name"
          onPress={() => trimmed && onSave(trimmed, relationship)}
          disabled={trimmed.length === 0}
          style={sheetStyles.action}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quickChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
  pressed: { opacity: 0.7 },
  ownerAction: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.accentSoft,
    gap: 1,
  },
});
