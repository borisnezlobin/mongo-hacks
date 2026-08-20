import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import type { Icon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, radii, spacing } from '../constants/theme';

interface SheetProps {
  visible: boolean;
  title: string;
  body?: string;
  icon?: Icon;
  /** Rendered in the icon slot instead of an icon — the naming sheet shows a face there. */
  leading?: ReactNode;
  /** A recording in progress must not be dismissed by a stray tap on the scrim. */
  dismissable?: boolean;
  onDismiss(): void;
  children: ReactNode;
}

/**
 * The bottom sheet. Naming, enrollment and summon each carried their own copy of this
 * chrome — same modal, same grabber, same scrim, same header, three times over.
 */
export function Sheet({
  visible,
  title,
  body,
  icon: IconComponent,
  leading,
  dismissable = true,
  onDismiss,
  children,
}: SheetProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} onPress={dismissable ? onDismiss : undefined} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            {leading ?? (IconComponent ? <IconComponent size={28} color={colors.accent} weight="fill" /> : null)}
            <View style={styles.headerCopy}>
              <AppText variant="title">{title}</AppText>
              {body ? <AppText variant="body" color={colors.inkMuted}>{body}</AppText> : null}
            </View>
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The one text field style the sheets share. */
export const sheetStyles = StyleSheet.create({
  input: {
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.button,
    paddingHorizontal: spacing.lg,
    height: 46,
    fontFamily: 'Manrope_400Regular',
    fontSize: 15,
    color: colors.ink,
  },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  action: { flex: 1 },
});

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim },
  container: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.lineStrong,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', marginBottom: spacing.xs },
  headerCopy: { flex: 1, gap: spacing.xs },
});
