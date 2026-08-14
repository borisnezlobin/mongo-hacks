import { useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, TextInput, View } from 'react-native';
import { CaretRightIcon, MagnifyingGlassIcon, UsersThreeIcon, WaveformIcon, XIcon } from 'phosphor-react-native';
import { AppText } from '../components/app-text';
import { Avatar } from '../components/avatar';
import { Chip, EmptyState } from '../components/ui';
import { colors, layout, radii, spacing } from '../constants/theme';
import { useNavigation } from '../lib/navigation';
import { displayName, isUnnamed, usePeople, useStore, type PersonRecord } from '../lib/store';

interface PeopleScreenProps {
  contentInset: number;
  onEnrollOwner?(): void;
}

/** Unnamed voices sort into their own group at the top — they are the ones needing action. */
const UNNAMED_SECTION = 'Waiting for a name';

export function PeopleScreen({ contentInset, onEnrollOwner }: PeopleScreenProps) {
  const people = usePeople();
  const { state } = useStore();
  const navigation = useNavigation();
  const [query, setQuery] = useState('');

  const factsByPerson = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const fact of Object.values(state.facts)) {
      if (fact.superseded_by) continue;
      (map[fact.person_id] ??= []).push(fact.claim);
    }
    return map;
  }, [state.facts]);

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = people.filter((person) => {
      if (!needle) return true;
      const haystack = [displayName(person), person.relationship ?? '', ...(factsByPerson[person._id] ?? [])]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });

    const groups = new Map<string, PersonRecord[]>();
    for (const person of matches) {
      const letter = isUnnamed(person) ? UNNAMED_SECTION : displayName(person).charAt(0).toUpperCase();
      const bucket = groups.get(letter);
      if (bucket) bucket.push(person);
      else groups.set(letter, [person]);
    }

    return [...groups.entries()]
      .sort(([a], [b]) => {
        if (a === UNNAMED_SECTION) return -1;
        if (b === UNNAMED_SECTION) return 1;
        return a.localeCompare(b);
      })
      .map(([title, data]) => ({ title, data }));
  }, [people, query, factsByPerson]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <AppText variant="title">People</AppText>
          {onEnrollOwner ? (
            <Pressable
              onPress={onEnrollOwner}
              hitSlop={8}
              accessibilityLabel="Teach Amelia your voice"
              style={({ pressed }) => [styles.enrollButton, pressed && styles.pressed]}
            >
              <WaveformIcon size={15} color={colors.accent} weight="bold" />
              <AppText variant="caption" color={colors.accent}>Your voice</AppText>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.searchField}>
          <MagnifyingGlassIcon size={17} color={colors.inkFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search names and what you know"
            placeholderTextColor={colors.inkFaint}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query.length > 0 ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
              <XIcon size={15} color={colors.inkFaint} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(person) => person._id}
        stickySectionHeadersEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.list, { paddingBottom: contentInset }]}
        ListEmptyComponent={
          <EmptyState
            icon={UsersThreeIcon}
            title={query ? 'No one matches that' : 'No one yet'}
            body={query ? 'Try a name, or something they told you.' : 'Everyone Amelia hears shows up here.'}
          />
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <AppText variant="label" color={colors.inkMuted}>{section.title}</AppText>
          </View>
        )}
        renderItem={({ item }) => {
          const facts = factsByPerson[item._id] ?? [];
          const unnamed = isUnnamed(item);
          return (
            <Pressable
              onPress={() => navigation.openPerson(item._id)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Avatar person={item} size={44} />
              <View style={styles.rowCopy}>
                <View style={styles.rowTitle}>
                  <AppText variant="bodyStrong" numberOfLines={1} style={styles.flexible}>
                    {displayName(item)}
                  </AppText>
                  {item.is_owner ? <Chip label="You" tone="accent" /> : null}
                  {unnamed ? <Chip label="Unnamed" tone="live" /> : null}
                </View>
                <AppText variant="caption" numberOfLines={1}>
                  {item.relationship ?? facts[0] ?? 'Nothing recorded yet'}
                </AppText>
              </View>
              <CaretRightIcon size={16} color={colors.inkFaint} />
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: layout.screenPadding, gap: spacing.md, paddingBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  enrollButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    height: 44,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    color: colors.ink,
    paddingVertical: 0,
  },
  list: { paddingHorizontal: layout.screenPadding },
  sectionHeader: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.canvas,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flexible: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
