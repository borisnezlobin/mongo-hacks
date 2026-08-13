import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { Icon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, radii, shadows, spacing } from '../constants/theme';

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Floating surfaces are the only place glass is allowed: recording bar, Amelia pill. */
export function GlassSurface({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.glass, style]}>{children}</View>;
}

interface ButtonProps extends Omit<PressableProps, 'style'> {
  label: string;
  variant?: 'primary' | 'secondary' | 'quiet';
  icon?: Icon;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({ label, variant = 'primary', icon: IconComponent, full, style, disabled, ...rest }: ButtonProps) {
  const tone = variant === 'primary' ? colors.inkInverse : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'quiet' && styles.buttonQuiet,
        full && styles.buttonFull,
        (pressed || disabled) && styles.buttonPressed,
        style,
      ]}
      {...rest}
    >
      {IconComponent ? <IconComponent size={17} color={tone} weight="bold" /> : null}
      <AppText variant="bodyStrong" color={tone}>{label}</AppText>
    </Pressable>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <AppText variant="label" color={colors.inkMuted}>{title}</AppText>
      {action}
    </View>
  );
}

export function Chip({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'accent' | 'live' | 'positive' }) {
  const palette = {
    neutral: { background: colors.canvasSunken, text: colors.inkMuted },
    accent: { background: colors.accentSoft, text: colors.accent },
    live: { background: colors.liveSoft, text: colors.live },
    positive: { background: colors.positiveSoft, text: colors.positive },
  }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: palette.background }]}>
      <AppText variant="caption" color={palette.text}>{label}</AppText>
    </View>
  );
}

export function EmptyState({ title, body, icon: IconComponent }: { title: string; body: string; icon?: Icon }) {
  return (
    <View style={styles.empty}>
      {IconComponent ? <IconComponent size={26} color={colors.inkFaint} weight="light" /> : null}
      <AppText variant="heading" align="center">{title}</AppText>
      <AppText variant="body" color={colors.inkMuted} align="center">{body}</AppText>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    padding: spacing.lg,
    ...shadows.card,
  },
  glass: {
    backgroundColor: colors.glass,
    borderRadius: radii.pill,
    ...shadows.floating,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surface, ...shadows.card },
  buttonQuiet: { backgroundColor: colors.canvasSunken },
  buttonFull: { alignSelf: 'stretch' },
  buttonPressed: { opacity: 0.72 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.pill,
    alignSelf: 'flex-start',
  },
  empty: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  divider: { height: 1, backgroundColor: colors.line },
});
