import { useMemo } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  CameraIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  PencilSimpleIcon,
} from 'phosphor-react-native';
import type { Id } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { Avatar } from '../components/avatar';
import { Card, Chip, SectionHeader } from '../components/ui';
import { colors, layout, radii, spacing } from '../constants/theme';
import { attributeLabel, formatDay, formatDue } from '../lib/format';
import { saveAvatar } from '../lib/avatars';
import { useNavigation } from '../lib/navigation';
import {
  displayName,
  isUnnamed,
  useConversations,
  useCurrentFacts,
  usePromisesFor,
  useStore,
  useSupersededFacts,
  OWNER_PERSON_ID,
} from '../lib/store';

interface PersonScreenProps {
  personId: Id;
  onRename(personId: Id): void;
  contentInset: number;
}

export function PersonScreen({ personId, onRename, contentInset }: PersonScreenProps) {
  const { state, setAvatar, closePromise, reopenPromise } = useStore();
  const navigation = useNavigation();
  const person = state.people[personId];
  const facts = useCurrentFacts(personId);
  const superseded = useSupersededFacts(personId);
  const promises = usePromisesFor(personId);
  const conversations = useConversations();

  const theirConversations = useMemo(
    () => conversations.filter((conversation) => conversation.participant_ids.includes(personId)),
    [conversations, personId],
  );

  const supersededByFact = useMemo(() => {
    const map: Record<Id, string> = {};
    for (const fact of superseded) {
      if (fact.superseded_by) map[fact.superseded_by] = fact.claim;
    }
    return map;
  }, [superseded]);

  const pickAvatar = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets[0]) return;
    // The picker's URI points into the cache, which is both wiped on reload and
    // eligible for eviction. Copy it somewhere permanent first.
    setAvatar(personId, saveAvatar(personId, result.assets[0].uri));
  };

  if (!person) {
    return (
      <View style={styles.container}>
        <BackRow onPress={navigation.back} />
        <AppText variant="body" style={styles.missing}>That person is no longer here.</AppText>
      </View>
    );
  }

  const owed = promises.filter((promise) => promise.person_id !== OWNER_PERSON_ID);
  const owing = promises.filter((promise) => promise.person_id === OWNER_PERSON_ID);

  return (
    <View style={styles.container}>
      <BackRow onPress={navigation.back} />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: contentInset }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.profile}>
          <Pressable onPress={pickAvatar} style={styles.avatarButton} accessibilityLabel="Change photo">
            <Avatar person={person} size={84} />
            <View style={styles.avatarBadge}>
              <CameraIcon size={13} color={colors.inkInverse} weight="fill" />
            </View>
          </Pressable>
          <View style={styles.profileCopy}>
            <View style={styles.nameRow}>
              <AppText variant="display" numberOfLines={2} style={styles.flexible}>
                {displayName(person)}
              </AppText>
              <Pressable onPress={() => onRename(personId)} hitSlop={8} accessibilityLabel="Edit name">
                <PencilSimpleIcon size={18} color={colors.inkFaint} />
              </Pressable>
            </View>
            {person.relationship ? (
              <AppText variant="body" color={colors.inkMuted}>{person.relationship}</AppText>
            ) : null}
            {isUnnamed(person) ? (
              <Pressable onPress={() => onRename(personId)} style={styles.namePrompt}>
                <AppText variant="caption" color={colors.accent}>Give this voice a name</AppText>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="What you know" />
          {facts.length === 0 ? (
            <AppText variant="body" color={colors.inkMuted}>Nothing yet. It fills in as they talk.</AppText>
          ) : (
            facts.map((fact) => (
              <Card key={fact._id} style={styles.factCard}>
                <View style={styles.factHeader}>
                  <Chip label={attributeLabel(fact.attribute)} tone="accent" />
                  <AppText variant="caption">{formatDay(fact.valid_from)}</AppText>
                </View>
                <AppText variant="body">{fact.claim}</AppText>
                {supersededByFact[fact._id] ? (
                  <AppText variant="caption" color={colors.inkFaint}>
                    Updated from “{supersededByFact[fact._id]}”
                  </AppText>
                ) : null}
              </Card>
            ))
          )}
        </View>

        {owed.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title={`${displayName(person)} owes you`} />
            {owed.map((promise) => (
              <PromiseRow
                key={promise._id}
                text={promise.text}
                due={promise.due_at}
                done={promise.status !== 'open'}
                onToggle={() => (promise.status === 'open' ? closePromise(promise._id) : reopenPromise(promise._id))}
              />
            ))}
          </View>
        ) : null}

        {owing.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="You owe them" />
            {owing.map((promise) => (
              <PromiseRow
                key={promise._id}
                text={promise.text}
                due={promise.due_at}
                done={promise.status !== 'open'}
                onToggle={() => (promise.status === 'open' ? closePromise(promise._id) : reopenPromise(promise._id))}
              />
            ))}
          </View>
        ) : null}

        {theirConversations.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Conversations" />
            {theirConversations.map((conversation) => (
              <Pressable
                key={conversation._id}
                onPress={() => navigation.openConversation(conversation._id)}
                style={({ pressed }) => [styles.conversationRow, pressed && styles.pressed]}
              >
                <View style={styles.flexible}>
                  <AppText variant="bodyStrong" numberOfLines={1}>
                    {conversation.title ?? 'Untitled conversation'}
                  </AppText>
                  <AppText variant="caption">{formatDay(conversation.started_at)}</AppText>
                </View>
                <CaretRightIcon size={16} color={colors.inkFaint} />
              </Pressable>
            ))}
          </View>
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

function PromiseRow({
  text,
  due,
  done,
  onToggle,
}: {
  text: string;
  due?: string;
  done: boolean;
  onToggle(): void;
}) {
  return (
    <Pressable onPress={onToggle} style={({ pressed }) => [styles.promiseRow, pressed && styles.pressed]}>
      {done
        ? <CheckCircleIcon size={21} color={colors.positive} weight="fill" />
        : <CircleIcon size={21} color={colors.lineStrong} />}
      <View style={styles.flexible}>
        <AppText variant="body" style={done ? styles.doneText : undefined}>{text}</AppText>
        <View style={styles.dueRow}>
          <ClockIcon size={12} color={colors.inkFaint} />
          <AppText variant="caption">{formatDue(due)}</AppText>
        </View>
      </View>
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
  scroll: { paddingHorizontal: layout.screenPadding, gap: spacing.xl, paddingTop: spacing.sm },
  missing: { paddingHorizontal: layout.screenPadding },
  profile: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  avatarButton: { width: 84, height: 84 },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 26,
    height: 26,
    borderRadius: radii.pill,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileCopy: { flex: 1, gap: spacing.xs },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  namePrompt: { alignSelf: 'flex-start' },
  section: { gap: spacing.sm },
  factCard: { gap: spacing.sm },
  factHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  promiseRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  doneText: { textDecorationLine: 'line-through', color: colors.inkFaint },
  conversationRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  flexible: { flex: 1, flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
