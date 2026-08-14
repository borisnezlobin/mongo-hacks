import { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Clipboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { CaretLeftIcon, CheckIcon, PencilSimpleIcon } from 'phosphor-react-native';
import type { Id } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { AmeliaMessage } from '../components/amelia-message';
import { Chip } from '../components/ui';
import { UtteranceRow } from '../components/utterance-row';
import { colors, layout, radii, spacing } from '../constants/theme';
import { api } from '../lib/api';
import { TRANSCRIPT_POLL_MS } from '../lib/config';
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
  onNamePerson(person: PersonRecord, utteranceIds?: string[]): void;
  contentInset: number;
}

export function ConversationScreen({ conversationId, onNamePerson, contentInset }: ConversationScreenProps) {
  const { state, renameConversation, ingest, upsertConversations } = useStore();
  const navigation = useNavigation();
  const utterances = useConversationUtterances(conversationId);
  const conversation = state.conversations[conversationId];
  // VAD emits stray fragments — a lone "." or a single stray word. They are noise in a
  // transcript someone is reading, so they are hidden rather than stored differently.
  const visible = utterances
    .filter((u) => u.text.replace(/[^a-zA-Z0-9]/g, '').length > 1)
    // The provider sometimes emits the same sentence twice under different ids; showing it
    // twice makes the transcript look broken.
    .filter((u, i, all) => i === 0 || all[i - 1].text.trim() !== u.text.trim());
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
  const lastCount = useRef(0);
  useEffect(() => {
    const grew = visible.length > lastCount.current;
    lastCount.current = visible.length;
    // Polling re-renders constantly; scrolling on every render yanked the view even when
    // nothing new had arrived. Only a genuinely longer transcript pulls you down.
    if (!isLive || !grew) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [visible.length, isLive]);

  /**
   * Hydrate on open, then keep polling while the conversation is live.
   *
   * SSE alone is not dependable in front of an audience: many reverse proxies (Cloudflare
   * tunnels among them) buffer event streams and release nothing until the stream closes,
   * which shows up as a recording that produces no transcript at all. Polling the same
   * REST endpoint is plain request/response, so it survives any proxy. Utterances are keyed
   * by id, so whichever path delivers a turn first wins and the other is a no-op.
   */
  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      const summary = await api.getConversation(conversationId).catch(() => null);
      if (!summary || cancelled) return;
      // Take the server's record too: without it the screen fabricates started_at from
      // ingest time, which then wins forever and sorts the list wrongly.
      if (summary.conversation) upsertConversations([summary.conversation]);
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
    };

    void pull();
    // Poll whenever the screen is open, not only while this phone is recording. A replay
    // driven from the server is someone else writing turns into this conversation, and
    // without polling it those turns never arrive.
    const interval = setInterval(() => void pull(), TRANSCRIPT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversationId, ingest, isLive, upsertConversations]);

  const commitTitle = () => {
    renameConversation(conversationId, draftTitle);
    setEditingTitle(false);
  };

  /**
   * Long-press a turn for the things you actually want from a transcript:
   * its text, or the speaker's name when Amelia got it wrong.
   *
   * Clipboard comes from react-native core, which warns that it is deprecated.
   * expo-clipboard is the successor but is a native module, and adding one
   * means rebuilding the dev client — not worth blocking on. Swap it at the
   * next native rebuild.
   */
  const onUtteranceMenu = (utterance: { _id: Id; text: string; start_ms: number }, person?: PersonRecord) => {
    const speaker = person ? person.name : 'Unknown speaker';
    const withSpeaker = `${speaker}: ${utterance.text}`;
    const actions: { label: string; run(): void }[] = [
      { label: 'Copy text', run: () => Clipboard.setString(utterance.text) },
      { label: 'Copy with speaker', run: () => Clipboard.setString(withSpeaker) },
      {
        label: person ? 'Change speaker' : 'Name this speaker',
        run: () => onNamePerson(
          person ?? {
            _id: utterance._id,
            owner_id: conversation?.owner_id ?? OWNER_PERSON_ID,
            name: '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          [utterance._id],
        ),
      },
    ];

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...actions.map((a) => a.label), 'Cancel'], cancelButtonIndex: actions.length },
        (index) => actions[index]?.run(),
      );
      return;
    }
    Alert.alert(speaker, utterance.text, [
      ...actions.map((a) => ({ text: a.label, onPress: a.run })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
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
        {visible.map((utterance, index) => {
          const person = utterance.person_id ? state.people[utterance.person_id] : undefined;
          const previous = visible[index - 1];
          // Unattributed turns never share a header. Grouping them implied consecutive
          // unknown turns came from one person, so someone else's line appeared under the
          // previous speaker's name — the transcript asserting something it does not know.
          const showHeader =
            !previous || !utterance.person_id || previous.person_id !== utterance.person_id;
          // One naming affordance per run of turns, on the first of the run. Keying it on
          // the utterance id gave every message its own button, because unresolved speakers
          // share neither a person id nor a voiceprint id to group on.
          const runIds: string[] = [];
          if (showHeader) {
            for (let i = index; i < visible.length; i += 1) {
              if (visible[i].person_id !== utterance.person_id) break;
              runIds.push(visible[i]._id);
            }
          }
          return (
            <UtteranceRow
              key={utterance._id}
              utterance={utterance}
              person={person}
              showHeader={showHeader}
              attributing={state.attributing[utterance._id] === true}
              onLongPress={() => onUtteranceMenu(utterance, person)}
              onPressPerson={() => person && navigation.openPerson(person._id)}
              // Unattributed turns still need a way in, so synthesise a person record from
              // the voiceprint. Without this the speaker Amelia has not resolved yet — often
              // the owner's own voice — was the one row you could not name.
              onName={!showHeader ? undefined : () => onNamePerson(
                person ?? {
                  _id: utterance.person_id ?? utterance.voiceprint_id ?? `speaker-${utterance._id}`,
                  owner_id: conversation.owner_id,
                  name: '',
                  voiceprint_id: utterance.voiceprint_id,
                  created_at: utterance.created_at,
                  updated_at: utterance.updated_at,
                },
                runIds,
              )}
            />
          );
        })}

        {ameliaTurn ? <AmeliaMessage turn={ameliaTurn} /> : null}

        {visible.length === 0 ? (
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
