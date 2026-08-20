import { memo, useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import {
  ArrowUpIcon,
  CaretRightIcon,
  ChatsCircleIcon,
  MagnifyingGlassIcon,
  XIcon,
} from 'phosphor-react-native';
import type { Conversation } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { Avatar } from '../components/avatar';
import { SwipeToDelete } from '../components/swipe-to-delete';
import { Card, Chip, EmptyState, SectionHeader } from '../components/ui';
import { colors, layout, radii, spacing } from '../constants/theme';
import { useAsk } from '../lib/ask';
import { formatDay, formatDuration } from '../lib/format';
import { useNavigation } from '../lib/navigation';
import { useLiveConversationId, useListedConversations, useOpenPromiseCount, usePerson } from '../state/hooks';
import { displayName } from '../state/reducer';
import { useActions, useSelector } from '../state/store';

interface HomeScreenProps {
  contentInset: number;
}

export function HomeScreen({ contentInset }: HomeScreenProps) {
  const conversations = useListedConversations();
  const openPromiseCount = useOpenPromiseCount();
  const liveConversationId = useLiveConversationId();
  const navigation = useNavigation();
  const actions = useActions();
  const { ask, clear, pending, result } = useAsk();
  const [query, setQuery] = useState('');

  const submit = () => ask(query);

  const confirmDelete = useCallback((conversationId: string, title: string) => {
    Alert.alert(
      `Delete "${title}"?`,
      'The transcript and anything Amelia remembered from it are removed. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          // Optimistic, but a refusal puts it back and says so rather than letting it
          // reappear silently on the next hydrate.
          onPress: () => void actions.deleteConversation(conversationId),
        },
      ],
    );
  }, [actions]);

  const openConversation = useCallback(
    (conversationId: string) => navigation.openConversation(conversationId),
    [navigation],
  );

  return (
    <View style={styles.container}>
      <View style={styles.pageHeader}>
        <View style={styles.wordmarkRow}>
          <AppText variant="title">Amelia</AppText>
          <AppText variant="caption">
            {openPromiseCount > 0
              ? `${openPromiseCount} open ${openPromiseCount === 1 ? 'loop' : 'loops'}`
              : 'All caught up'}
          </AppText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: contentInset }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {result ? (
          <Card style={styles.answerCard}>
            <View style={styles.answerHeader}>
              <AppText variant="label" color={colors.accent}>Amelia</AppText>
              {result.local ? <Chip label="Answered from this phone" /> : null}
            </View>
            <AppText variant="body">{result.text}</AppText>
            {result.citations.map((citation) => (
              <Citation
                key={`${citation.kind}-${citation.id}`}
                personId={citation.person_id}
                text={citation.text}
                kind={citation.kind}
                onOpenPerson={navigation.openPerson}
              />
            ))}
          </Card>
        ) : null}

        <View style={styles.askSection}>
          <SectionHeader title="Ask across memory" />
          <View style={styles.askField}>
            <MagnifyingGlassIcon size={18} color={colors.inkFaint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Ask about anyone you've met"
              placeholderTextColor={colors.inkFaint}
              style={styles.askInput}
              returnKeyType="search"
              onSubmitEditing={submit}
            />
            {query.length > 0 ? (
              <Pressable onPress={() => { setQuery(''); clear(); }} accessibilityLabel="Clear" hitSlop={8}>
                <XIcon size={16} color={colors.inkFaint} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={submit}
              disabled={query.trim().length === 0 || pending}
              style={({ pressed }) => [styles.askSubmit, (pressed || query.trim().length === 0) && styles.dimmed]}
              accessibilityLabel="Ask Amelia"
            >
              {pending
                ? <ActivityIndicator size="small" color={colors.inkInverse} />
                : <ArrowUpIcon size={16} color={colors.inkInverse} weight="bold" />}
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Recent conversations" />
          {conversations.length === 0 ? (
            <EmptyState
              icon={ChatsCircleIcon}
              title="Nothing recorded yet"
              body="Start listening and the room fills in here, speaker by speaker."
            />
          ) : (
            conversations.map((conversation) => (
              <ConversationRow
                key={conversation._id}
                conversation={conversation}
                live={conversation._id === liveConversationId}
                onOpen={openConversation}
                onDelete={confirmDelete}
              />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const Citation = memo(function Citation({
  personId,
  text,
  kind,
  onOpenPerson,
}: {
  personId?: string;
  text: string;
  kind: string;
  onOpenPerson(personId: string): void;
}) {
  const person = usePerson(personId);
  return (
    <Pressable style={styles.citation} onPress={() => person && onOpenPerson(person._id)}>
      <Avatar person={person} size={26} />
      <View style={styles.citationCopy}>
        <AppText variant="body">{text}</AppText>
        <AppText variant="caption">{person ? displayName(person) : 'Unattributed'} · {kind}</AppText>
      </View>
    </Pressable>
  );
});

/**
 * Memoized and subscribed to its own participants, so a turn arriving in one
 * conversation does not repaint every other row in the list.
 */
const ConversationRow = memo(function ConversationRow({
  conversation,
  live,
  onOpen,
  onDelete,
}: {
  conversation: Conversation;
  live: boolean;
  onOpen(conversationId: string): void;
  onDelete(conversationId: string, title: string): void;
}) {
  const participantIds = conversation.participant_ids;
  const participants = useSelector(
    useCallback(
      (state) => participantIds.map((id) => state.people[id]).filter(Boolean),
      [participantIds],
    ),
    (a, b) => a.length === b.length && a.every((person, index) => person === b[index]),
  );
  const title = conversation.title ?? 'Untitled conversation';

  return (
    <SwipeToDelete onDelete={() => onDelete(conversation._id, title)}>
      <Pressable
        onPress={() => onOpen(conversation._id)}
        style={({ pressed }) => [styles.conversationRow, pressed && styles.dimmed]}
      >
        {/* Copy first, avatars after. A leading avatar stack is as wide as the
            conversation has participants, so every title started at a different x. */}
        <View style={styles.conversationCopy}>
          <View style={styles.conversationTitleRow}>
            <AppText variant="bodyStrong" numberOfLines={1} style={styles.flexible}>{title}</AppText>
            {live ? <Chip label="Live" tone="live" /> : null}
          </View>
          <AppText variant="caption" numberOfLines={1}>
            {formatDay(conversation.started_at)}
            {conversation.ended_at ? ` · ${formatDuration(conversation.started_at, conversation.ended_at)}` : ''}
            {participants.length > 0 ? ` · ${participants.map((person) => displayName(person)).join(', ')}` : ''}
          </AppText>
        </View>
        <View style={styles.conversationAvatars}>
          {participants.slice(0, 3).map((person, index) => (
            <View key={person._id} style={[styles.stackedAvatar, index > 0 && styles.stackedAvatarOverlap]}>
              <Avatar person={person} size={26} />
            </View>
          ))}
        </View>
        <CaretRightIcon size={16} color={colors.inkFaint} />
      </Pressable>
    </SwipeToDelete>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  pageHeader: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.md,
    backgroundColor: colors.canvas,
  },
  wordmarkRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  askSection: { gap: 0 },
  askField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    height: 48,
  },
  askInput: {
    flex: 1,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    color: colors.ink,
    paddingVertical: 0,
  },
  askSubmit: {
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dimmed: { opacity: 0.55 },
  scroll: { paddingHorizontal: layout.screenPadding, gap: spacing.lg, paddingTop: spacing.sm },
  answerCard: { gap: spacing.md },
  answerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  citation: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  citationCopy: { flex: 1, gap: 1 },
  stackedAvatar: { borderRadius: radii.pill, backgroundColor: colors.surface },
  stackedAvatarOverlap: { marginLeft: -10 },
  section: { gap: spacing.xs },
  conversationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  conversationAvatars: { flexDirection: 'row' },
  conversationCopy: { flex: 1, gap: 2 },
  conversationTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flexible: { flexShrink: 1 },
});
