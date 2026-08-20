import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, TextInput, View } from 'react-native';
import { CaretRightIcon, MagnifyingGlassIcon, UsersThreeIcon, WaveformIcon, XIcon } from 'phosphor-react-native';
import { AppText } from '../components/app-text';
import { Avatar } from '../components/avatar';
import { NameSuggestionCard } from '../components/name-suggestion-card';
import { Chip, EmptyState } from '../components/ui';
import { colors, layout, radii, spacing } from '../constants/theme';
import { useNavigation } from '../lib/navigation';
import { useClaimsByPerson, useNameSuggestion, usePeople } from '../state/hooks';
import { useActions } from '../state/store';
import { displayName, isUnnamed, speakerLabel, type PersonRecord } from '../state/reducer';

interface PeopleScreenProps {
  contentInset: number;
  onEnrollOwner?(): void;
}

/** Unnamed voices sort into their own group at the top — they are the ones needing action. */
const UNNAMED_SECTION = 'Waiting for a name';

export function PeopleScreen({ contentInset, onEnrollOwner }: PeopleScreenProps) {
  const people = usePeople();
  const claimsByPerson = useClaimsByPerson();
  const navigation = useNavigation();
  const actions = useActions();
  const [query, setQuery] = useState('');

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = people.filter((person) => {
      if (!needle) return true;
      const haystack = [displayName(person), person.relationship ?? '', ...(claimsByPerson[person._id] ?? [])]
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

    const unnamed = groups.get(UNNAMED_SECTION);
    // Oldest voice first, so a number belongs to a voice for good rather than shuffling
    // every time somebody new speaks.
    if (unnamed) unnamed.sort((a, b) => a.created_at.localeCompare(b.created_at));

    return [...groups.entries()]
      .sort(([a], [b]) => {
        if (a === UNNAMED_SECTION) return -1;
        if (b === UNNAMED_SECTION) return 1;
        return a.localeCompare(b);
      })
      .map(([title, data]) => ({ title, data }));
  }, [people, query, claimsByPerson]);

  /**
   * With seven people in the room several voices are unnamed at once, and a list of
   * identical "Unknown speaker" rows is impossible to work through — you cannot tell
   * which one you already looked at. Numbering them, alongside the colour each voice
   * already carries in its avatar, makes them separate people you can work down.
   */
  const unknownIndexes = useMemo(() => {
    const indexes = new Map<string, number>();
    const unnamedSection = sections.find((section) => section.title === UNNAMED_SECTION);
    unnamedSection?.data.forEach((person, index) => indexes.set(person._id, index + 1));
    return indexes;
  }, [sections]);

  const openPerson = useCallback((personId: string) => navigation.openPerson(personId), [navigation]);

  // The same write the naming sheet makes, so the voiceprint is enrolled either way.
  const confirmSuggestedName = useCallback(
    (personId: string, name: string) => void actions.namePerson({ personId, name }),
    [actions],
  );

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
        renderItem={({ item }) => (
          <PersonRow
            person={item}
            subtitle={item.relationship ?? claimsByPerson[item._id]?.[0] ?? 'Nothing recorded yet'}
            unknownIndex={unknownIndexes.get(item._id)}
            onPress={openPerson}
            onConfirmName={confirmSuggestedName}
          />
        )}
      />
    </View>
  );
}

/**
 * Unnamed voices are already bucketed at the top of this screen, which makes it the
 * other place the owner is looking straight at a voice that needs a name — so an
 * overheard one is offered right there, with the words that produced it.
 */
const PersonRow = memo(function PersonRow({
  person,
  subtitle,
  unknownIndex,
  onPress,
  onConfirmName,
}: {
  person: PersonRecord;
  subtitle: string;
  unknownIndex?: number;
  onPress(personId: string): void;
  onConfirmName(personId: string, name: string): void;
}) {
  const unnamed = isUnnamed(person);
  const suggestion = useNameSuggestion(person._id);
  const label = unnamed && unknownIndex !== undefined
    ? displayName(person, unknownIndex)
    : speakerLabel(person);

  return (
    <View>
      <Pressable
        onPress={() => onPress(person._id)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <Avatar person={person} size={44} />
        <View style={styles.rowCopy}>
          <View style={styles.rowTitle}>
            <AppText variant="bodyStrong" numberOfLines={1} style={styles.flexible}>
              {label}
            </AppText>
            {person.is_owner ? <Chip label="You" tone="accent" /> : null}
            {unnamed ? <Chip label="Unnamed" tone="live" /> : null}
            {person.provisional && !unnamed ? <Chip label="Not sure yet" /> : null}
          </View>
          <AppText variant="caption" numberOfLines={1}>{subtitle}</AppText>
        </View>
        <CaretRightIcon size={16} color={colors.inkFaint} />
      </Pressable>

      {suggestion ? (
        <NameSuggestionCard
          suggestion={suggestion}
          onConfirm={(name) => onConfirmName(person._id, name)}
        />
      ) : null}
    </View>
  );
});

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
