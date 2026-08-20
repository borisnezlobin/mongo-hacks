import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { HandshakeIcon } from 'phosphor-react-native';
import type { PromiseMemory } from '../../../shared/contracts';
import { AppText } from '../components/app-text';
import { PromiseRow } from '../components/promise-row';
import { EmptyState, SectionHeader } from '../components/ui';
import { colors, layout, spacing } from '../constants/theme';
import { useNavigation } from '../lib/navigation';
import { useClosedPromises, useOwedToYou, usePerson, useUtterance, useYouOwe } from '../state/hooks';
import { useActions } from '../state/store';

interface LoopsScreenProps {
  contentInset: number;
}

export function LoopsScreen({ contentInset }: LoopsScreenProps) {
  const owed = useOwedToYou();
  const owing = useYouOwe();
  const closed = useClosedPromises();
  const [showClosed, setShowClosed] = useState(false);

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
            {owed.map((promise) => <LoopCard key={promise._id} promise={promise} />)}
          </View>
        ) : null}

        {/* Who "you" are comes from the person marked as owner, which the store already
            tracks. It used to compare against a seed constant, so against a real server
            this section was permanently empty. */}
        {owing.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="You owe" />
            {owing.map((promise) => <LoopCard key={promise._id} promise={promise} />)}
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
            {showClosed ? closed.map((promise) => <LoopCard key={promise._id} promise={promise} />) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Subscribes to just its own person and source turn, so one loop repaints at a time. */
function LoopCard({ promise }: { promise: PromiseMemory }) {
  const person = usePerson(promise.person_id);
  const source = useUtterance(promise.source_utterance_id);
  const navigation = useNavigation();
  const actions = useActions();

  const toggle = useCallback(
    (promiseId: string, status: PromiseMemory['status']) => void actions.setPromiseStatus(promiseId, status),
    [actions],
  );
  const openPerson = useCallback((personId: string) => navigation.openPerson(personId), [navigation]);

  return (
    <PromiseRow
      promise={promise}
      person={person}
      sourceText={source?.text}
      showAttribution
      onToggle={toggle}
      onOpenPerson={openPerson}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: layout.screenPadding, paddingBottom: spacing.lg, gap: 2 },
  scroll: { paddingHorizontal: layout.screenPadding, gap: spacing.xl },
  section: { gap: spacing.md },
});
