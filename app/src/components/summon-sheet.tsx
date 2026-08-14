import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SparkleIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { Button } from './ui';
import { colors, radii, spacing } from '../constants/theme';

interface SummonSheetProps {
  visible: boolean;
  pending: boolean;
  onCancel(): void;
  onSummon(text: string): void;
}

/**
 * Press-and-hold manual summon — the stage fallback for a failed owner voice
 * match. Holding the phone is the authorization, so no voiceprint gate applies.
 * One field, one button: type the request and Amelia answers out loud.
 */
export function SummonSheet({ visible, pending, onCancel, onSummon }: SummonSheetProps) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (visible) setText('');
  }, [visible]);

  const trimmed = text.trim();
  const submit = () => {
    if (trimmed && !pending) onSummon(trimmed);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <Pressable style={styles.scrim} onPress={onCancel} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <SparkleIcon size={28} color={colors.accent} weight="fill" />
            <View style={styles.headerCopy}>
              <AppText variant="title">Ask Amelia</AppText>
              <AppText variant="body" color={colors.inkMuted}>
                Type it and she answers out loud — no wake phrase needed.
              </AppText>
            </View>
          </View>

          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="e.g. Remind me to follow up with Maya tonight"
            placeholderTextColor={colors.inkFaint}
            autoFocus
            multiline
            style={[styles.input, styles.multiline]}
            returnKeyType="done"
            onSubmitEditing={submit}
            blurOnSubmit
          />

          <View style={styles.actions}>
            <Button label="Cancel" variant="quiet" onPress={onCancel} style={styles.action} />
            <Button
              label={pending ? 'Asking…' : 'Ask out loud'}
              onPress={submit}
              disabled={trimmed.length === 0 || pending}
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
    paddingTop: 12,
    height: 46,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    color: colors.ink,
  },
  multiline: { height: 96 },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  action: { flex: 1 },
});
