import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { AppText } from './app-text';
import { Avatar } from './avatar';
import { Button } from './ui';
import { colors, radii, spacing } from '../constants/theme';
import type { PersonRecord } from '../lib/store';

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
    <Modal visible={Boolean(person)} animationType="slide" transparent onRequestClose={onCancel}>
      <Pressable style={styles.scrim} onPress={onCancel} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <Avatar person={person ?? undefined} size={52} />
            <View style={styles.headerCopy}>
              <AppText variant="title">Who is this?</AppText>
              <AppText variant="body" color={colors.inkMuted}>
                Everything this voice already said gets filed under the name you give it.
              </AppText>
            </View>
          </View>

          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Name"
            placeholderTextColor={colors.inkFaint}
            autoFocus
            autoCapitalize="words"
            style={styles.input}
            returnKeyType="done"
            onSubmitEditing={() => trimmed && onSave(trimmed, relationship)}
          />
          <TextInput
            value={relationship}
            onChangeText={setRelationship}
            placeholder="How you know them (optional)"
            placeholderTextColor={colors.inkFaint}
            style={styles.input}
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

          <View style={styles.actions}>
            <Button label="Not now" variant="quiet" onPress={onCancel} style={styles.action} />
            <Button
              label="Save name"
              onPress={() => trimmed && onSave(trimmed, relationship)}
              disabled={trimmed.length === 0}
              style={styles.action}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim },
  container: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.lineStrong,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', marginBottom: spacing.xs },
  headerCopy: { flex: 1, gap: spacing.xs },
  input: {
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.button,
    paddingHorizontal: spacing.lg,
    height: 46,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    color: colors.ink,
  },
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
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  action: { flex: 1 },
});
