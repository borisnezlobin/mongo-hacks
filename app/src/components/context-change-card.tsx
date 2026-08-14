import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  LinkSimpleIcon,
  UsersThreeIcon,
} from 'phosphor-react-native';
import { AppText } from './app-text';
import { Avatar } from './avatar';
import { Card, Chip, Divider } from './ui';
import { colors, radii, spacing } from '../constants/theme';
import { humanizeAttribute, type ContextChange } from '../lib/context-changes';
import type { PersonRecord } from '../lib/store';

interface ContextChangeCardProps {
  change: ContextChange;
  person?: PersonRecord;
  defaultExpanded?: boolean;
  onOpenConversation?(): void;
}

export function ContextChangeCard({
  change,
  person,
  defaultExpanded = false,
  onOpenConversation,
}: ContextChangeCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const rippleCount = change.affected_promises.length;
  const gapCount = change.may_have_missed.length;

  return (
    <Card style={styles.card}>
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        style={styles.header}
        accessibilityRole="button"
        accessibilityLabel={`${change.person_name}'s ${humanizeAttribute(change.attribute)} changed`}
      >
        <Avatar person={person} size={38} />
        <View style={styles.headerCopy}>
          <AppText variant="heading">{change.person_name}’s {humanizeAttribute(change.attribute)} changed</AppText>
          <AppText variant="caption">Amelia kept both versions</AppText>
        </View>
        {expanded
          ? <CaretDownIcon size={17} color={colors.inkFaint} />
          : <CaretRightIcon size={17} color={colors.inkFaint} />}
      </Pressable>

      <View style={styles.diff}>
        <View style={styles.diffRow}>
          <AppText variant="caption" style={styles.diffLabel}>Before</AppText>
          <AppText variant="body" color={colors.inkMuted} style={styles.before}>{change.before.claim}</AppText>
        </View>
        <View style={styles.diffRule} />
        <View style={styles.diffRow}>
          <AppText variant="caption" color={colors.positive} style={styles.diffLabel}>Now</AppText>
          <AppText variant="bodyStrong" style={styles.diffValue}>{change.after.claim}</AppText>
        </View>
      </View>

      <View style={styles.signals}>
        <Chip label={`${rippleCount} ${rippleCount === 1 ? 'linked loop' : 'linked loops'}`} tone={rippleCount ? 'accent' : 'neutral'} />
        {gapCount > 0 ? <Chip label={`${gapCount} may need this`} /> : <Chip label="Room covered" tone="positive" />}
      </View>

      {expanded ? (
        <View style={styles.details}>
          <Divider />
          <DetailRow icon={CheckCircleIcon} title="Decision trace">
            Amelia will use “{change.after.claim}” and keep the previous value only as history.
          </DetailRow>

          <DetailRow icon={LinkSimpleIcon} title="What this may affect">
            {change.affected_promises.length > 0
              ? change.affected_promises.map((promise) => promise.text).join(' · ')
              : 'No open loops appear to depend on this change.'}
          </DetailRow>

          <DetailRow icon={UsersThreeIcon} title="Recorded context">
            {change.recorded_with.length > 0
              ? `Recorded with ${change.recorded_with.map((item) => item.name).join(', ')}.`
              : 'The source turn is linked, but no other recorded speakers were confirmed before it.'}
            {change.may_have_missed.length > 0
              ? ` ${change.may_have_missed.map((item) => item.name).join(', ')} may still have the earlier context.`
              : ''}
          </DetailRow>

          {change.conversation_id && onOpenConversation ? (
            <Pressable onPress={onOpenConversation} style={styles.sourceButton} accessibilityRole="button">
              <AppText variant="label" color={colors.accent}>Open source conversation</AppText>
              <CaretRightIcon size={15} color={colors.accent} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function DetailRow({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof CheckCircleIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIcon}><Icon size={16} color={colors.accent} weight="bold" /></View>
      <View style={styles.detailCopy}>
        <AppText variant="label" color={colors.ink}>{title}</AppText>
        <AppText variant="caption" color={colors.inkMuted}>{children}</AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md, padding: 0, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, paddingBottom: 0 },
  headerCopy: { flex: 1, gap: 1 },
  diff: { marginHorizontal: spacing.lg, borderRadius: radii.button, backgroundColor: colors.surfaceMuted },
  diffRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, padding: spacing.md },
  diffLabel: { width: 45, paddingTop: 2 },
  diffValue: { flex: 1 },
  before: { flex: 1, textDecorationLine: 'line-through' },
  diffRule: { height: 1, backgroundColor: colors.line, marginLeft: 69 },
  signals: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  details: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  detailRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  detailIcon: { width: 24, height: 24, borderRadius: radii.pill, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  detailCopy: { flex: 1, gap: 2 },
  sourceButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: spacing.xs },
});
