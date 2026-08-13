import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { CaretLeftIcon, CheckIcon, PencilSimpleIcon } from 'phosphor-react-native';
import type { Id } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { AmeliaMessage } from '../components/amelia-message';
import { Chip } from '../components/ui';
import { UtteranceRow } from '../components/utterance-row';
import { colors, layout, radii, spacing } from '../constants/theme';
import { api } from '../lib/api';
import { formatDay } from '../lib/format';
import { useNavigation } from '../lib/navigation';
import {
  OWNER_PERSON_ID,
  useConversationUtterances,
  useStore,
  type PersonRecord,
} from '../lib/store';

interface ConversationScreenProps {
  conversationId: Id;
  onNamePerson(person: PersonRecord): void;
  contentInset: number;
}

export function ConversationScreen({ conversationId, onNamePerson, contentInset }: ConversationScreenProps) {
  const { state, renameConversation, ingest } = useStore();
  const navigation = useNavigation();
  const utterances = useConversationUtterances(conversationId);
  const conversation = state.conversations[conversationId];
  const scrollRef = useRef<ScrollView>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation?.title ?? '');

  useEffect(() => {
    setDraftTitle(conversation?.title ?? '');
  }, [conversation?.title]);

  const isLive = state.liveConversationId === conversationId;
  const ameliaTurn = state.amelia && (!state.amelia.conversation_id || state.amelia.conversation_id === conversationId)
    ? state.amelia
    : null;

  // New turns should pull the view down only while the conversation is actually live.
  useEffect(() => {
    if (!isLive) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [utterances.length, ameliaTurn?.steps.length, ameliaTurn?.reply, isLive]);

  // SSE only carries what happens while the app is open, so a reload used to look like the
  // transcript had been deleted. Hydrate from the server on open; the store keys utterances
  // by id, so anything the live stream already delivered is replaced, not duplicated.
  useEffect(() => {
    let cancelled = false;
    void api.getConversation(conversationId)
      .then((summary) => {
        if (cancelled) return;
        for (const utterance of summary.utterances) {
          ingest({
            type: 'utterance',
            utterance_id: utterance._id,
            conversation_id: utterance.conversation_id,
            person_id: utterance.person_id,
            voiceprint_id: utterance.voiceprint_id,
            text: utterance.text,
            start_ms: utterance.start_ms,
            end_ms: utterance.end_ms,
            is_final: utterance.is_final,
          });
        }
      })
      .catch(() => {
        // Offline or not yet persisted: the live stream is still the source of truth.
      });
    return () => { cancelled = true; };
  }, [conversationId, ingest]);

  const commitTitle = () => {
    renameConversation(conversationId, draftTitle);
    setEditingTitle(false);
  };

  // A live conversation has no record until the first utterance arrives, so an empty id is
  // "waiting for the first voice", not "missing".
  if (!conversation) {
    return (
      <View style={styles.container}>
        <BackRow onPress={navigation.back} />
        <View style={styles.waitingBlock}>
          <AppText variant="title">Listening</AppText>
          <AppText variant="body" color={colors.inkMuted}>
            The transcript starts as soon as someone speaks.
          </AppText>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <BackRow onPress={navigation.back} />

      <View style={styles.titleBlock}>
        {editingTitle ? (
          <View style={styles.titleEditRow}>
            <TextInput
              value={draftTitle}
              onChangeText={setDraftTitle}
              autoFocus
              style={styles.titleInput}
              placeholder="Name this conversation"
              placeholderTextColor={colors.inkFaint}
              returnKeyType="done"
              onSubmitEditing={commitTitle}
            />
            <Pressable onPress={commitTitle} hitSlop={8} accessibilityLabel="Save title">
              <CheckIcon size={19} color={colors.accent} weight="bold" />
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.titleRow} onPress={() => setEditingTitle(true)}>
            <AppText variant="title" numberOfLines={2} style={styles.flexible}>
              {conversation.title ?? 'Untitled conversation'}
            </AppText>
            <PencilSimpleIcon size={17} color={colors.inkFaint} />
          </Pressable>
        )}
        <View style={styles.metaRow}>
          <AppText variant="caption">{formatDay(conversation.started_at)}</AppText>
          {isLive ? <Chip label="Listening now" tone="live" /> : null}
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.scroll, { paddingBottom: contentInset }]}
        showsVerticalScrollIndicator={false}
      >
        {utterances.map((utterance, index) => {
          const person = utterance.person_id ? state.people[utterance.person_id] : undefined;
          const previous = utterances[index - 1];
          const showHeader = !previous || previous.person_id !== utterance.person_id;
          // One naming affordance per speaker, on their first turn — not one per message.
          const speakerKey = utterance.person_id ?? utterance.voiceprint_id ?? utterance._id;
          const isFirstTurnForSpeaker =
            utterances.findIndex((u) => (u.person_id ?? u.voiceprint_id ?? u._id) === speakerKey) === index;
          return (
            <UtteranceRow
              key={utterance._id}
              utterance={utterance}
              person={person}
              showHeader={showHeader}
              onPressPerson={() => person && navigation.openPerson(person._id)}
              // Unattributed turns still need a way in, so synthesise a person record from
              // the voiceprint. Without this the speaker Amelia has not resolved yet — often
              // the owner's own voice — was the one row you could not name.
              onName={!isFirstTurnForSpeaker ? undefined : () => onNamePerson(person ?? {
                _id: utterance.person_id ?? utterance.voiceprint_id ?? utterance._id,
                owner_id: conversation.owner_id,
                name: '',
                voiceprint_id: utterance.voiceprint_id,
                created_at: utterance.created_at,
                updated_at: utterance.updated_at,
              })}
            />
          );
        })}

        {ameliaTurn ? <AmeliaMessage turn={ameliaTurn} /> : null}

        {utterances.length === 0 ? (
          <AppText variant="body" color={colors.inkMuted} style={styles.waiting}>
            Waiting for the first voice.
          </AppText>
        ) : null}
      </ScrollView>
    </View>
  );
}

function BackRow({ onPress }: { onPress(): void }) {
  return (
    <Pressable onPress={onPress} style={styles.backRow} accessibilityLabel="Back" hitSlop={8}>
      <CaretLeftIcon size={20} color={colors.ink} />
      <AppText variant="bodyStrong">Back</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.sm,
  },
  titleBlock: { paddingHorizontal: layout.screenPadding, gap: spacing.xs, paddingBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleEditRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleInput: {
    flex: 1,
    fontFamily: 'Newsreader_500Medium',
    fontSize: 24,
    color: colors.ink,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.button,
    paddingHorizontal: spacing.md,
    height: 46,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scroll: { paddingHorizontal: layout.screenPadding, paddingTop: spacing.xs },
  waiting: { paddingTop: spacing.xl },
  waitingBlock: { paddingHorizontal: layout.screenPadding, gap: spacing.xs, paddingTop: spacing.xl },
  missing: { paddingHorizontal: layout.screenPadding },
  flexible: { flex: 1, flexShrink: 1 },
});
