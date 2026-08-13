import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { CheckCircleIcon, CircleIcon, ClockIcon, HandshakeIcon } from 'phosphor-react-native';
import type { PromiseMemory } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { Avatar } from '../components/avatar';
import { Card, EmptyState, SectionHeader } from '../components/ui';
import { colors, layout, spacing } from '../constants/theme';
import { formatDue } from '../lib/format';
import { useNavigation } from '../lib/navigation';
import { displayName, OWNER_PERSON_ID, useStore } from '../lib/store';

interface LoopsScreenProps {
  contentInset: number;
}

export function LoopsScreen({ contentInset }: LoopsScreenProps) {
  const { state, closePromise, reopenPromise } = useStore();
  const navigation = useNavigation();
  const [showClosed, setShowClosed] = useState(false);

  const { owed, owing, closed } = useMemo(() => {
    const all = Object.values(state.promises);
    const open = all.filter((promise) => promise.status === 'open');
    const sortByDue = (a: PromiseMemory, b: PromiseMemory) =>
      (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');
    return {
      owed: open.filter((promise) => promise.person_id !== OWNER_PERSON_ID).sort(sortByDue),
      owing: open.filter((promise) => promise.person_id === OWNER_PERSON_ID).sort(sortByDue),
      closed: all.filter((promise) => promise.status !== 'open'),
    };
  }, [state.promises]);

  const renderPromise = (promise: PromiseMemory) => {
    const person = state.people[promise.person_id];
    const source = state.utterances[promise.source_utterance_id];
    const done = promise.status !== 'open';
    return (
      <Card key={promise._id} style={styles.card}>
        <View style={styles.cardTop}>
          <Pressable
            onPress={() => (done ? reopenPromise(promise._id) : closePromise(promise._id))}
            hitSlop={10}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: done }}
            accessibilityLabel={done ? 'Reopen' : 'Mark done'}
          >
            {done
              ? <CheckCircleIcon size={23} color={colors.positive} weight="fill" />
              : <CircleIcon size={23} color={colors.lineStrong} />}
          </Pressable>
          <View style={styles.cardCopy}>
            <AppText variant="bodyStrong" style={done ? styles.doneText : undefined}>{promise.text}</AppText>
            <View style={styles.dueRow}>
              <ClockIcon size={12} color={colors.inkFaint} />
              <AppText variant="caption">{formatDue(promise.due_at)}</AppText>
            </View>
          </View>
        </View>

        {source ? (
          <View style={styles.sourceQuote}>
            <AppText variant="body" color={colors.inkMuted}>“{source.text}”</AppText>
          </View>
        ) : null}

        <Pressable
          style={styles.attribution}
          onPress={() => person && navigation.openPerson(person._id)}
          disabled={!person}
        >
          <Avatar person={person} size={22} />
          <AppText variant="caption">
            {person ? displayName(person) : 'Unattributed'}
          </AppText>
        </Pressable>
      </Card>
    );
  };

  const nothingOpen = owed.length === 0 && owing.length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AppText variant="title">Loops</AppText>
        <AppText variant="caption">Everything said out loud that is still open</AppText>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: contentInset }]}
        showsVerticalScrollIndicator={false}
      >
        {nothingOpen ? (
          <EmptyState
            icon={HandshakeIcon}
            title="No open loops"
            body="When someone promises you something, or you promise them, it lands here."
          />
        ) : null}

        {owed.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Owed to you" />
            {owed.map(renderPromise)}
          </View>
        ) : null}

        {owing.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="You owe" />
            {owing.map(renderPromise)}
          </View>
        ) : null}

        {closed.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader
              title={`Closed (${closed.length})`}
              action={
                <Pressable onPress={() => setShowClosed((value) => !value)} hitSlop={8}>
                  <AppText variant="caption" color={colors.accent}>{showClosed ? 'Hide' : 'Show'}</AppText>
                </Pressable>
              }
            />
            {showClosed ? closed.map(renderPromise) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: layout.screenPadding, paddingBottom: spacing.lg, gap: 2 },
  scroll: { paddingHorizontal: layout.screenPadding, gap: spacing.xl },
  section: { gap: spacing.md },
  card: { gap: spacing.md },
  cardTop: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  cardCopy: { flex: 1, gap: 2 },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  doneText: { textDecorationLine: 'line-through', color: colors.inkFaint },
  sourceQuote: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 10,
    padding: spacing.md,
  },
  attribution: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
