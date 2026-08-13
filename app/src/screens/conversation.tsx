import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { CaretLeftIcon, CheckIcon, PencilSimpleIcon } from 'phosphor-react-native';
import type { Id } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { AmeliaMessage } from '../components/amelia-message';
import { Chip } from '../components/ui';
import { UtteranceBubble } from '../components/utterance-bubble';
import { colors, layout, radii, spacing } from '../constants/theme';
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
  const { state, renameConversation } = useStore();
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

  const commitTitle = () => {
    renameConversation(conversationId, draftTitle);
    setEditingTitle(false);
  };

  if (!conversation) {
    return (
      <View style={styles.container}>
        <BackRow onPress={navigation.back} />
        <AppText variant="body" style={styles.missing}>That conversation is gone.</AppText>
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
          return (
            <UtteranceBubble
              key={utterance._id}
              utterance={utterance}
              person={person}
              isOwner={utterance.person_id === OWNER_PERSON_ID}
              showHeader={showHeader}
              onPressPerson={() => person && navigation.openPerson(person._id)}
              onName={person ? () => onNamePerson(person) : undefined}
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
  missing: { paddingHorizontal: layout.screenPadding },
  flexible: { flex: 1, flexShrink: 1 },
});
