import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CheckCircleIcon, CircleIcon, ClockIcon } from 'phosphor-react-native';
import type { PromiseMemory } from '../../../shared/contracts';
import { AppText } from './app-text';
import { Avatar } from './avatar';
import { Card } from './ui';
import { colors, spacing } from '../constants/theme';
import { formatDue } from '../lib/format';
import { displayName, type PersonRecord } from '../state/reducer';

interface PromiseRowProps {
  promise: PromiseMemory;
  /** Loops shows the sentence it came from and who said it; a profile already knows. */
  sourceText?: string;
  person?: PersonRecord;
  showAttribution?: boolean;
  onToggle(promiseId: string, next: PromiseMemory['status']): void;
  onOpenPerson?(personId: string): void;
}

/**
 * One promise, everywhere. Loops and the profile had two hand-written versions of this
 * that drifted: one could reopen a closed promise, the other could not.
 *
 * Memoized on its props so ticking one loop does not repaint the rest of the list.
 */
export const PromiseRow = memo(function PromiseRow({
  promise,
  sourceText,
  person,
  showAttribution = false,
  onToggle,
  onOpenPerson,
}: PromiseRowProps) {
  const done = promise.status !== 'open';

  const body = (
    <>
      <View style={styles.top}>
        <Pressable
          onPress={() => onToggle(promise._id, done ? 'open' : 'done')}
          hitSlop={10}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: done }}
          accessibilityLabel={done ? 'Reopen' : 'Mark done'}
        >
          {done
            ? <CheckCircleIcon size={22} color={colors.positive} weight="fill" />
            : <CircleIcon size={22} color={colors.lineStrong} />}
        </Pressable>
        <View style={styles.copy}>
          <AppText variant="bodyStrong" style={done ? styles.doneText : undefined}>{promise.text}</AppText>
          <View style={styles.dueRow}>
            <ClockIcon size={12} color={colors.inkFaint} />
            <AppText variant="caption">{formatDue(promise.due_at)}</AppText>
          </View>
        </View>
      </View>

      {sourceText ? (
        <View style={styles.quote}>
          <AppText variant="body" color={colors.inkMuted}>“{sourceText}”</AppText>
        </View>
      ) : null}

      {showAttribution ? (
        <Pressable
          style={styles.attribution}
          onPress={() => person && onOpenPerson?.(person._id)}
          disabled={!person || !onOpenPerson}
        >
          <Avatar person={person} size={22} />
          <AppText variant="caption">{person ? displayName(person) : 'Unattributed'}</AppText>
        </Pressable>
      ) : null}
    </>
  );

  if (!sourceText && !showAttribution) return <View style={styles.plain}>{body}</View>;
  return <Card style={styles.card}>{body}</Card>;
});

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  plain: { gap: spacing.sm, paddingVertical: spacing.md },
  top: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  copy: { flex: 1, gap: 2 },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  doneText: { textDecorationLine: 'line-through', color: colors.inkFaint },
  quote: { backgroundColor: colors.surfaceMuted, borderRadius: 10, padding: spacing.md },
  attribution: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
