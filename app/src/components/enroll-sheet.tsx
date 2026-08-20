import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { WaveformIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { Sheet, sheetStyles } from './sheet';
import { Button } from './ui';
import { colors, radii } from '../constants/theme';
import { ENROLL_DURATION_MS, useOwnerEnrollment } from '../../audio/useOwnerEnrollment';
import { useOwnerId, usePerson } from '../state/hooks';

interface EnrollSheetProps {
  visible: boolean;
  onClose(): void;
}

/**
 * Teaches Amelia the owner's voice so "Hey Amelia" gates on a voiceprint instead of
 * failing closed. The name starts from whoever is already marked as the owner rather
 * than from a hardcoded demo name.
 */
export function EnrollSheet({ visible, onClose }: EnrollSheetProps) {
  const { state, progress, error, start, reset } = useOwnerEnrollment();
  const ownerId = useOwnerId();
  const owner = usePerson(ownerId ?? undefined);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!visible) return;
    reset();
    setName(owner?.name ?? '');
    // Reopening the sheet is the reset point; the owner record is read once at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const recording = state === 'recording';
  const busy = state === 'uploading';
  const done = state === 'done';
  const trimmed = name.trim();
  const seconds = Math.round(ENROLL_DURATION_MS / 1000);

  return (
    <Sheet
      visible={visible}
      title="Teach Amelia your voice"
      body={`Speak naturally for ${seconds} seconds. After this, "hey Amelia" knows it's you.`}
      icon={WaveformIcon}
      dismissable={!recording}
      onDismiss={onClose}
    >
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Your name"
        placeholderTextColor={colors.inkFaint}
        autoCapitalize="words"
        editable={!recording && !busy}
        style={sheetStyles.input}
      />

      {recording ? (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      ) : null}

      {error ? <AppText variant="caption" color={colors.live}>{error}</AppText> : null}
      {done ? (
        <AppText variant="caption" color={colors.positive}>
          Voice learned. Say "hey Amelia" and she'll know it's you.
        </AppText>
      ) : null}

      <View style={sheetStyles.actions}>
        <Button label="Close" variant="quiet" onPress={onClose} disabled={recording} style={sheetStyles.action} />
        <Button
          label={recording ? 'Listening…' : busy ? 'Saving…' : done ? 'Record again' : 'Start recording'}
          onPress={() => void start(trimmed)}
          disabled={recording || busy || trimmed.length === 0}
          style={sheetStyles.action}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  progressTrack: { height: 4, borderRadius: radii.pill, backgroundColor: colors.canvasSunken, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: radii.pill, backgroundColor: colors.live },
});
