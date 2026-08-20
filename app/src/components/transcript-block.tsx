import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { UserPlusIcon } from 'phosphor-react-native';
import type { Utterance } from '../../../shared/contracts';
import { AppText } from './app-text';
import { Avatar } from './avatar';
import { NameSuggestionCard } from './name-suggestion-card';
import type { Anchor } from './message-menu';
import { colors, spacing } from '../constants/theme';
import { formatOffset } from '../lib/format';
import type { TranscriptBlock as Block } from '../lib/transcript';
import { useIsAttributing, useNameSuggestion, usePerson } from '../state/hooks';
import { displayName, isUnnamed, speakerLabel } from '../state/reducer';

interface TranscriptBlockProps {
  block: Block;
  /**
   * Which unnamed voice this is, so seven anonymous people are tellable apart. Undefined
   * once the voice has a name.
   */
  unknownIndex?: number;
  /** True only on the first block this voice speaks, so one voice is asked about once. */
  offerSuggestion: boolean;
  onPressPerson(personId: string): void;
  onName(block: Block): void;
  onConfirmName(block: Block, name: string): void;
  onLongPress(utterance: Utterance, anchor: Anchor): void;
}

const AVATAR_SIZE = 36;

/**
 * One speaker's run of consecutive turns, under a single header.
 *
 * The lines inside sit flush against each other so a sentence the VAD chopped into four
 * turns reads as one paragraph, while each line stays its own pressable target — the
 * turn is still the unit you copy or re-attribute, it just is not the unit you read.
 *
 * The whole block is memoized and subscribes to its own speaker, so a turn arriving at
 * the bottom of a 48-minute transcript repaints one block.
 */
export const TranscriptBlockRow = memo(function TranscriptBlockRow({
  block,
  unknownIndex,
  offerSuggestion,
  onPressPerson,
  onName,
  onConfirmName,
  onLongPress,
}: TranscriptBlockProps) {
  const person = usePerson(block.personId);
  const attributing = useIsAttributing(block.id);
  const suggestion = useNameSuggestion(block.voiceKey);

  const identityFade = useRef(new Animated.Value(1)).current;
  const previousPersonId = useRef(block.personId);

  useEffect(() => {
    if (previousPersonId.current === block.personId) return;
    previousPersonId.current = block.personId;
    // A re-label changes who a block belongs to after it is on screen. It crossfades so
    // it reads as a correction rather than a flicker.
    Animated.sequence([
      Animated.timing(identityFade, { toValue: 0, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(identityFade, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [block.personId, identityFade]);

  const unnamed = !person || isUnnamed(person);
  const pending = attributing && !person;

  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    if (!pending) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pending, pulse]);

  const label = unnamed && unknownIndex !== undefined
    ? displayName(person, unknownIndex)
    : speakerLabel(person);

  return (
    <View style={styles.block}>
      <View style={styles.gutter}>
        <Animated.View style={{ opacity: identityFade }}>
          <Pressable
            onPress={() => (person ? onPressPerson(person._id) : onName(block))}
            accessibilityLabel={label}
          >
            {/* Seeded on the voice, so an unnamed speaker keeps one colour across the
                whole transcript and two of them never collide. */}
            <Avatar person={person} seed={block.voiceKey} size={AVATAR_SIZE} shape="rounded" />
          </Pressable>
        </Animated.View>
      </View>

      <View style={styles.column}>
        <Animated.View style={[styles.header, { opacity: identityFade }]}>
          {pending ? (
            <Animated.View style={{ opacity: pulse }}>
              <AppText variant="bodyStrong" color={colors.inkMuted} style={styles.name}>Attributing…</AppText>
            </Animated.View>
          ) : (
            <Pressable
              onPress={() => (unnamed ? onName(block) : person && onPressPerson(person._id))}
              style={styles.nameRow}
            >
              <AppText
                variant="bodyStrong"
                color={unnamed ? colors.accent : person?.provisional ? colors.inkMuted : colors.ink}
                style={styles.name}
              >
                {label}
              </AppText>
              {unnamed ? <UserPlusIcon size={13} color={colors.accent} weight="bold" /> : null}
            </Pressable>
          )}
          <AppText variant="caption">{formatOffset(block.startMs)}</AppText>
        </Animated.View>

        {offerSuggestion && suggestion ? (
          <NameSuggestionCard suggestion={suggestion} onConfirm={(name) => onConfirmName(block, name)} />
        ) : null}

        <View style={styles.lines}>
          {block.utterances.map((utterance) => (
            <TranscriptLine key={utterance._id} utterance={utterance} onLongPress={onLongPress} />
          ))}
        </View>
      </View>
    </View>
  );
});

/** One turn. Measured in window coordinates on press so the menu opens against it. */
const TranscriptLine = memo(function TranscriptLine({
  utterance,
  onLongPress,
}: {
  utterance: Utterance;
  onLongPress(utterance: Utterance, anchor: Anchor): void;
}) {
  const bodyRef = useRef<View>(null);
  return (
    <View ref={bodyRef} collapsable={false}>
      <Pressable
        onLongPress={() => bodyRef.current?.measureInWindow((x, y, width, height) =>
          onLongPress(utterance, { x, y, width, height }))}
        delayLongPress={280}
      >
        {({ pressed }) => (
          <AppText
            variant="body"
            color={utterance.is_final ? colors.ink : colors.inkMuted}
            style={pressed ? styles.pressed : undefined}
          >
            {utterance.text}
            {utterance.is_final ? '' : '…'}
          </AppText>
        )}
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  // The gap between blocks is what makes a change of speaker obvious at reading speed;
  // lines inside a block have none, so a run reads as one paragraph.
  block: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  gutter: { width: AVATAR_SIZE, alignItems: 'center' },
  column: { flex: 1, gap: 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 20 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  name: { fontFamily: 'Manrope_700Bold' },
  lines: { gap: 0 },
  pressed: { opacity: 0.65 },
});
