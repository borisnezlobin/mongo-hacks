import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import {
  ArrowUpIcon,
  CaretRightIcon,
  ChatsCircleIcon,
  SparkleIcon,
  UserPlusIcon,
  XIcon,
} from 'phosphor-react-native';
import { AppText } from '../components/app-text';
import { Avatar } from '../components/avatar';
import { Card, Chip, EmptyState, SectionHeader } from '../components/ui';
import { colors, layout, radii, spacing } from '../constants/theme';
import { api } from '../lib/api';
import { useAsk } from '../lib/ask';
import { formatDay, formatDuration } from '../lib/format';
import { useNavigation } from '../lib/navigation';
import { displayName, useConversations, useStore, useUnknownPeople, type PersonRecord } from '../lib/store';

interface HomeScreenProps {
  onNamePerson(person: PersonRecord): void;
  contentInset: number;
}

export function HomeScreen({ onNamePerson, contentInset }: HomeScreenProps) {
  const { state, dismissUnknownCard, ingest } = useStore();
  const conversations = useConversations();
  const unknown = useUnknownPeople();
  const navigation = useNavigation();
  const { ask, clear, pending, result } = useAsk();
  const [query, setQuery] = useState('');

  const openPromiseCount = useMemo(
    () => Object.values(state.promises).filter((promise) => promise.status === 'open').length,
    [state.promises],
  );

  const showUnknownCard = unknown.length > 0 && !state.unknownCardDismissed;

  // Recent conversations came only from what this app instance had seen, so past
  // recordings were invisible after a restart. Pull the server's list and hydrate each
  // one's turns; utterances are keyed by id, so re-seeing them is a no-op.
  useEffect(() => {
    let cancelled = false;
    void api.listConversations()
      .then(async (conversations) => {
        for (const conversation of conversations.slice(0, 8)) {
          if (cancelled) return;
          const summary = await api.getConversation(conversation._id).catch(() => null);
          if (!summary || cancelled) continue;
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
        }
      })
      .catch(() => {
        // No server yet: seeded and live data still render.
      });
    return () => { cancelled = true; };
  }, [ingest]);

  const submit = () => {
    ask(query);
  };

  return (
    <View style={styles.container}>
      <View style={styles.askHeader}>
        <View style={styles.wordmarkRow}>
          <AppText variant="title">Amelia</AppText>
          <AppText variant="caption">
            {openPromiseCount > 0 ? `${openPromiseCount} open ${openPromiseCount === 1 ? 'loop' : 'loops'}` : 'All caught up'}
          </AppText>
        </View>

        <View style={styles.askField}>
          <SparkleIcon size={18} color={colors.accent} weight="fill" />
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
            <Pressable
              onPress={() => { setQuery(''); clear(); }}
              accessibilityLabel="Clear"
              hitSlop={8}
            >
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

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: contentInset }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {result ? (
          <Card style={styles.answerCard}>
            <View style={styles.answerHeader}>
              <AppText variant="label" color={colors.accent}>Amelia</AppText>
              {result.local ? <Chip label="From this phone" /> : null}
            </View>
            <AppText variant="body">{result.text}</AppText>
            {result.citations.map((citation) => {
              const person = citation.person_id ? state.people[citation.person_id] : undefined;
              return (
                <Pressable
                  key={`${citation.kind}-${citation.id}`}
                  style={styles.citation}
                  onPress={() => person && navigation.openPerson(person._id)}
                >
                  <Avatar person={person} size={26} />
                  <View style={styles.citationCopy}>
                    <AppText variant="body">{citation.text}</AppText>
                    <AppText variant="caption">
                      {person ? displayName(person) : 'Unattributed'} · {citation.kind}
                    </AppText>
                  </View>
                </Pressable>
              );
            })}
          </Card>
        ) : null}

        {showUnknownCard ? (
          <Card style={styles.unknownCard}>
            <View style={styles.unknownHeader}>
              <View style={styles.unknownAvatars}>
                {unknown.slice(0, 3).map((person, index) => (
                  <View key={person._id} style={[styles.stackedAvatar, index > 0 && styles.stackedAvatarOverlap]}>
                    <Avatar person={person} size={34} />
                  </View>
                ))}
              </View>
              <Pressable onPress={dismissUnknownCard} hitSlop={10} accessibilityLabel="Dismiss">
                <XIcon size={16} color={colors.inkFaint} />
              </Pressable>
            </View>
            <AppText variant="heading">
              {unknown.length} {unknown.length === 1 ? 'voice' : 'voices'} without a name
            </AppText>
            <AppText variant="body" color={colors.inkMuted}>
              Amelia kept everything they said. Give them a name and it all files itself.
            </AppText>
            <View style={styles.unknownActions}>
              {unknown.slice(0, 3).map((person) => (
                <Pressable
                  key={person._id}
                  onPress={() => onNamePerson(person)}
                  style={({ pressed }) => [styles.nameButton, pressed && styles.dimmed]}
                >
                  <UserPlusIcon size={15} color={colors.accent} weight="bold" />
                  <AppText variant="caption" color={colors.accent}>Name this voice</AppText>
                </Pressable>
              ))}
            </View>
          </Card>
        ) : null}

        <View style={styles.section}>
          <SectionHeader title="Recent conversations" />
          {conversations.length === 0 ? (
            <EmptyState
              icon={ChatsCircleIcon}
              title="Nothing recorded yet"
              body="Start listening and the room fills in here, speaker by speaker."
            />
          ) : (
            conversations.map((conversation) => {
              const participants = conversation.participant_ids
                .map((id) => state.people[id])
                .filter(Boolean) as PersonRecord[];
              const isLive = conversation._id === state.liveConversationId;
              return (
                <Pressable
                  key={conversation._id}
                  onPress={() => navigation.openConversation(conversation._id)}
                  style={({ pressed }) => [styles.conversationRow, pressed && styles.dimmed]}
                >
                  <View style={styles.conversationAvatars}>
                    {participants.slice(0, 3).map((person, index) => (
                      <View key={person._id} style={[styles.stackedAvatar, index > 0 && styles.stackedAvatarOverlap]}>
                        <Avatar person={person} size={30} />
                      </View>
                    ))}
                  </View>
                  <View style={styles.conversationCopy}>
                    <View style={styles.conversationTitleRow}>
                      <AppText variant="bodyStrong" numberOfLines={1} style={styles.flexible}>
                        {conversation.title ?? 'Untitled conversation'}
                      </AppText>
                      {isLive ? <Chip label="Live" tone="live" /> : null}
                    </View>
                    <AppText variant="caption">
                      {formatDay(conversation.started_at)}
                      {conversation.ended_at ? ` · ${formatDuration(conversation.started_at, conversation.ended_at)}` : ''}
                      {participants.length > 0 ? ` · ${participants.map((person) => displayName(person)).join(', ')}` : ''}
                    </AppText>
                  </View>
                  <CaretRightIcon size={16} color={colors.inkFaint} />
                </Pressable>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  askHeader: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.md,
    gap: spacing.md,
    backgroundColor: colors.canvas,
  },
  wordmarkRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
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
  unknownCard: { gap: spacing.sm },
  unknownHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  unknownAvatars: { flexDirection: 'row' },
  stackedAvatar: { borderRadius: radii.pill, backgroundColor: colors.surface },
  stackedAvatarOverlap: { marginLeft: -10 },
  unknownActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  nameButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
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
