import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CloudSlashIcon, FlaskIcon, XIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, layout, radii, spacing } from '../constants/theme';
import { useConnection, useNotices } from '../state/hooks';
import { useActions } from '../state/store';

/**
 * The two things the owner must never have to guess at: whether Amelia is talking to a
 * server, and whether something they just did failed to save.
 *
 * Both used to be invisible. The stream source was captured into a state setter whose
 * value was thrown away, and every write swallowed its error, so a dead server looked
 * exactly like an account with nothing in it.
 */
export const StatusBanner = memo(function StatusBanner() {
  const connection = useConnection();
  const notices = useNotices();
  const actions = useActions();

  const rows = [
    ...(connection === 'offline'
      ? [{ id: 'offline', tone: 'error' as const, icon: CloudSlashIcon, message: "Can't reach Amelia's server. Showing what this phone has." }]
      : []),
    ...(connection === 'mock'
      ? [{ id: 'mock', tone: 'info' as const, icon: FlaskIcon, message: 'Showing sample data. Nothing here was recorded.' }]
      : []),
    ...notices.map((notice) => ({
      id: notice.id,
      tone: notice.tone,
      icon: undefined,
      message: notice.message,
      dismissable: true,
    })),
  ];

  if (rows.length === 0) return null;

  return (
    <View style={styles.stack} pointerEvents="box-none">
      {rows.map((row) => {
        const RowIcon = 'icon' in row ? row.icon : undefined;
        const tint = row.tone === 'error' ? colors.live : colors.inkMuted;
        return (
          <View
            key={row.id}
            style={[styles.row, row.tone === 'error' ? styles.rowError : styles.rowInfo]}
          >
            {RowIcon ? <RowIcon size={15} color={tint} weight="bold" /> : null}
            <AppText variant="caption" color={tint} style={styles.message}>{row.message}</AppText>
            {'dismissable' in row && row.dismissable ? (
              <Pressable onPress={() => actions.dismissNotice(row.id)} hitSlop={10} accessibilityLabel="Dismiss">
                <XIcon size={13} color={tint} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  stack: { paddingHorizontal: layout.screenPadding, paddingBottom: spacing.sm, gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
  },
  rowError: { backgroundColor: colors.liveSoft },
  rowInfo: { backgroundColor: colors.canvasSunken },
  message: { flex: 1 },
});
