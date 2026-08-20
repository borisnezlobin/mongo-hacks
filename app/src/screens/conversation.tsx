import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Clipboard,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { CheckIcon, CopyIcon, PencilSimpleIcon, TrashIcon, UserSwitchIcon } from 'phosphor-react-native';
import type { Id, Utterance } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { AmeliaMessage } from '../components/amelia-message';
import { BackRow } from '../components/back-row';
import { Chip } from '../components/ui';
import { MessageMenu, type Anchor, type MenuAction } from '../components/message-menu';
import { TranscriptBlockRow } from '../components/transcript-block';
import { colors, layout, radii, spacing } from '../constants/theme';
import { formatDay } from '../lib/format';
import { useTranscriptPolling } from '../lib/hydrate';
import { useNavigation } from '../lib/navigation';
import {
  useAmeliaTurnsFor,
  useConversation,
  useConversationUtterances,
  useLiveConversationId,
} from '../state/hooks';
import {
  buildTranscriptBlocks,
  speakerIdentityFor,
  unknownVoiceOrdinals,
  visibleTurns,
  voiceTurnIds,
  type TranscriptBlock,
} from '../lib/transcript';
import { displayName, isUnnamed, type PersonRecord } from '../state/reducer';
import { selectPeopleById, selectSessionSpeakers } from '../state/selectors';
import { useActions, useSelector, useStoreHandle } from '../state/store';

interface ConversationScreenProps {
  conversationId: Id;
  onNamePerson(person: PersonRecord, utteranceIds: string[]): void;
  contentInset: number;
}

const keyOfBlock = (block: TranscriptBlock) => block.id;

export function ConversationScreen({ conversationId, onNamePerson, contentInset }: ConversationScreenProps) {
  const conversation = useConversation(conversationId);
  const utterances = useConversationUtterances(conversationId);
  const ameliaTurns = useAmeliaTurnsFor(conversationId);
  const liveConversationId = useLiveConversationId();
  const navigation = useNavigation();
  const actions = useActions();
  const store = useStoreHandle();
  const listRef = useRef<FlatList<TranscriptBlock>>(null);
  /**
   * Whether new turns should pull the view down.
   *
   * The old rule was "scroll on every growth while live", which on a 48-minute recording
   * means you cannot read back over anything: scrolling up to re-read is undone by the
   * next turn a second later. Sticking only while you are already at the bottom is the
   * behaviour every chat app has, and it is what makes a long live transcript usable.
   */
  const stickToBottom = useRef(true);

  const sessionSpeakerOf = useSelector(selectSessionSpeakers);
  const visible = useMemo(() => visibleTurns(utterances), [utterances]);

  // Rebuilt against the previous list so unchanged blocks keep their identity: a live
  // transcript only appends, and without this every block would be a new object per tick.
  const blocksRef = useRef<TranscriptBlock[]>([]);
  const blocks = useMemo(() => {
    const next = buildTranscriptBlocks(visible, sessionSpeakerOf, blocksRef.current);
    blocksRef.current = next;
    return next;
  }, [visible, sessionSpeakerOf]);

  // Numbering the unnamed voices is what makes seven anonymous speakers tellable apart.
  const people = useSelector(selectPeopleById);
  const unknownIndexes = useMemo(
    () => unknownVoiceOrdinals(blocks, (voiceKey) => !isUnnamed(people[voiceKey])),
    [blocks, people],
  );

  // One voice is asked about once, on the first block it speaks. Anchoring the card to
  // every run would put dozens of identical cards down a long transcript.
  const suggestionAnchors = useMemo(() => {
    const seen = new Set<Id>();
    const anchors = new Set<Id>();
    for (const block of blocks) {
      if (seen.has(block.voiceKey)) continue;
      seen.add(block.voiceKey);
      anchors.add(block.id);
    }
    return anchors;
  }, [blocks]);

  const [menu, setMenu] = useState<
    { anchor: Anchor; speaker: string; text: string; actions: MenuAction[] } | null
  >(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation?.title ?? '');

  useEffect(() => {
    setDraftTitle(conversation?.title ?? '');
  }, [conversation?.title]);

  const isLive = liveConversationId === conversationId;

  const reportOffline = useCallback(
    () => actions.notify("Couldn't reach the server, so this transcript may be behind."),
    [actions],
  );
  useTranscriptPolling(conversationId, reportOffline, isLive);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    stickToBottom.current = distanceFromBottom < 120;
  }, []);

  /**
   * Growth is followed from the content size rather than the item count, because a
   * virtualized list only knows its real height once the new rows have laid out —
   * scrolling before that lands short of the bottom.
   */
  const firstLayout = useRef(true);
  const onContentSizeChange = useCallback(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      // A live transcript opens where the talking is; a finished one opens at the start,
      // because that is where you read from.
      if (!isLive) return;
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (!isLive || !stickToBottom.current) return;
    listRef.current?.scrollToEnd({ animated: true });
  }, [isLive]);

  const openPerson = useCallback((personId: Id) => navigation.openPerson(personId), [navigation]);

  /** Naming a voice names every turn in the block, which is the run it spoke. */
  const nameSpeaker = useCallback((block: TranscriptBlock) => {
    const state = store.getState();
    const first = block.utterances[0];
    const person = block.personId ? state.people[block.personId] : undefined;
    const ownerId = state.conversations[first.conversation_id]?.owner_id ?? 'owner';
    onNamePerson(
      person ?? speakerIdentityFor(first, ownerId, state.sessionSpeakerOf[first._id]),
      voiceTurnIds(blocksRef.current, block.voiceKey),
    );
  }, [onNamePerson, store]);

  /**
   * Confirming an overheard name is the same write as typing one into the naming sheet.
   * That matters beyond tidiness: the naming path is what persists the person and
   * enrolls the voiceprint, so it is the whole reason the voice is recognised in the
   * next conversation. A shortcut that only set local state would lose the feature.
   */
  const confirmSuggestedName = useCallback((block: TranscriptBlock, name: string) => {
    void actions.namePerson({
      personId: block.voiceKey,
      name,
      voiceprintId: block.utterances[0].voiceprint_id,
      utteranceIds: voiceTurnIds(blocksRef.current, block.voiceKey),
    });
  }, [actions]);

  /**
   * Long-press a turn. The menu opens against the message itself, so there is no doubt
   * which turn is about to change.
   *
   * Clipboard comes from react-native core, which warns that it is deprecated.
   * expo-clipboard is a native module, and adding one means rebuilding the dev client.
   */
  const openMenu = useCallback((utterance: Utterance, anchor: Anchor) => {
    const person = utterance.person_id ? store.getState().people[utterance.person_id] : undefined;
    const speaker = displayName(person);
    setMenu({
      anchor,
      speaker,
      text: utterance.text,
      actions: [
        { label: 'Copy text', icon: CopyIcon, run: () => Clipboard.setString(utterance.text) },
        {
          label: 'Copy with speaker',
          icon: CopyIcon,
          run: () => Clipboard.setString(`${speaker}: ${utterance.text}`),
        },
        {
          label: person ? 'Change speaker' : 'Name this speaker',
          icon: UserSwitchIcon,
          run: () => {
            const block = blocksRef.current.find(
              (candidate) => candidate.utterances.some((turn) => turn._id === utterance._id),
            );
            if (block) nameSpeaker(block);
          },
        },
      ],
    });
  }, [nameSpeaker, store]);

  const renderBlock = useCallback(({ item }: { item: TranscriptBlock }) => (
    <TranscriptBlockRow
      block={item}
      unknownIndex={unknownIndexes.get(item.voiceKey)}
      offerSuggestion={suggestionAnchors.has(item.id)}
      onPressPerson={openPerson}
      onName={nameSpeaker}
      onConfirmName={confirmSuggestedName}
      onLongPress={openMenu}
    />
  ), [unknownIndexes, suggestionAnchors, openPerson, nameSpeaker, confirmSuggestedName, openMenu]);

  const commitTitle = () => {
    actions.renameConversation(conversationId, draftTitle);
    setEditingTitle(false);
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete this conversation?',
      // Say what actually goes. Facts and promises cite a turn in this transcript, so
      // keeping them would leave memory asserting things it cannot show evidence for.
      'The transcript and anything Amelia remembered from it are removed. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            navigation.back();
            void actions.deleteConversation(conversationId);
          },
        },
      ],
    );
  };

  // A live conversation has no record until the first utterance arrives, so an empty id
  // is "waiting for the first voice", not "missing".
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
          <View style={styles.metaSpacer} />
          <Pressable onPress={confirmDelete} hitSlop={10} accessibilityLabel="Delete conversation">
            <TrashIcon size={17} color={colors.inkFaint} />
          </Pressable>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={blocks}
        keyExtractor={keyOfBlock}
        renderItem={renderBlock}
        contentContainerStyle={[styles.scroll, { paddingBottom: contentInset }]}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={onContentSizeChange}
        // Blocks are variable height, so there is no getItemLayout to give. These keep
        // the mounted window small without the blank-space flicker a tighter one causes.
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        updateCellsBatchingPeriod={50}
        windowSize={11}
        // Android only: on iOS this is known to blank out text in a recycled cell, and a
        // transcript that loses its words is worse than one that costs more memory.
        removeClippedSubviews={Platform.OS === 'android'}
        ListFooterComponent={
          <>
            {ameliaTurns.map((turn) => <AmeliaMessage key={turn.request_id} turn={turn} />)}
            {blocks.length === 0 ? (
              <AppText variant="body" color={colors.inkMuted} style={styles.waiting}>
                Waiting for the first voice.
              </AppText>
            ) : null}
          </>
        }
      />

      <MessageMenu
        anchor={menu?.anchor ?? null}
        speaker={menu?.speaker ?? ''}
        text={menu?.text ?? ''}
        actions={menu?.actions ?? []}
        onDismiss={() => setMenu(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  metaSpacer: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scroll: { paddingHorizontal: layout.screenPadding, paddingTop: spacing.xs },
  waiting: { paddingTop: spacing.xl },
  waitingBlock: { paddingHorizontal: layout.screenPadding, gap: spacing.xs, paddingTop: spacing.xl },
  flexible: { flex: 1, flexShrink: 1 },
});
