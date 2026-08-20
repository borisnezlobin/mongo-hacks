import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { ChatCircleIcon } from 'phosphor-react-native';
import { Sheet, sheetStyles } from './sheet';
import { Button } from './ui';
import { colors } from '../constants/theme';

interface SummonSheetProps {
  visible: boolean;
  pending: boolean;
  onCancel(): void;
  onSummon(text: string): void;
}

/**
 * Press-and-hold manual summon — the stage fallback for a failed owner voice match.
 * Holding the phone is the authorization, so no voiceprint gate applies.
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
    <Sheet
      visible={visible}
      title="Ask Amelia"
      body="Type it and she answers out loud — no wake phrase needed."
      icon={ChatCircleIcon}
      onDismiss={onCancel}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="e.g. Remind me to follow up with Maya tonight"
        placeholderTextColor={colors.inkFaint}
        autoFocus
        multiline
        style={[sheetStyles.input, styles.multiline]}
        returnKeyType="done"
        onSubmitEditing={submit}
        blurOnSubmit
      />

      <View style={sheetStyles.actions}>
        <Button label="Cancel" variant="quiet" onPress={onCancel} style={sheetStyles.action} />
        <Button
          label={pending ? 'Asking…' : 'Ask out loud'}
          onPress={submit}
          disabled={trimmed.length === 0 || pending}
          style={sheetStyles.action}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  multiline: { height: 96, paddingTop: 12 },
});
