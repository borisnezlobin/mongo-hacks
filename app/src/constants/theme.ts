import { Platform } from 'react-native';

/**
 * Amelia is light-only by direction. Every surface is paper: warm white over cream,
 * with a single rust accent so the recording and live states read at arm's length.
 */
export const colors = {
  canvas: '#FAF9F9',
  canvasSunken: '#F1EFEF',
  surface: '#FFFFFF',
  surfaceMuted: '#F8F6F6',
  line: '#E8E4E4',
  lineStrong: '#D6D1D1',

  ink: '#1B1918',
  inkMuted: '#5E5957',
  inkFaint: '#918B89',
  inkInverse: '#FFFFFF',

  accent: '#BE2D26',
  accentSoft: '#FCEBE9',
  live: '#D92D20',
  liveSoft: '#FDE7E4',
  positive: '#3F6B4A',
  positiveSoft: '#E4EDE5',

  glass: 'rgba(255, 255, 255, 0.86)',
  glassLine: 'rgba(27, 25, 24, 0.06)',
  scrim: 'rgba(27, 25, 24, 0.3)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Buttons are 8 or circular; cards get a softer 14. Nothing rounded carries a colored border. */
export const radii = {
  button: 8,
  card: 14,
  bubble: 16,
  pill: 999,
} as const;

export const fonts = {
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemibold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
  display: 'Newsreader_400Regular',
  displayMedium: 'Newsreader_500Medium',
  displaySemibold: 'Newsreader_600SemiBold',
} as const;

export type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  | 'mono';

export const typography: Record<TextVariant, {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
  letterSpacing?: number;
}> = {
  display: { fontFamily: fonts.display, fontSize: 34, lineHeight: 40, color: colors.ink, letterSpacing: -0.4 },
  title: { fontFamily: fonts.displayMedium, fontSize: 24, lineHeight: 30, color: colors.ink, letterSpacing: -0.2 },
  heading: { fontFamily: fonts.bodySemibold, fontSize: 17, lineHeight: 23, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: colors.ink },
  bodyStrong: { fontFamily: fonts.bodyMedium, fontSize: 15, lineHeight: 22, color: colors.ink },
  label: { fontFamily: fonts.bodyMedium, fontSize: 13, lineHeight: 18, color: colors.inkMuted },
  caption: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.inkFaint },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) as string,
    fontSize: 12,
    lineHeight: 17,
    color: colors.inkMuted,
  },
};

/** Shadows carry elevation instead of borders, which anti-alias badly on rounded corners. */
export const shadows = {
  card: {
    shadowColor: '#2B231A',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  floating: {
    shadowColor: '#2B231A',
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
} as const;

export const layout = {
  screenPadding: spacing.xl,
  tabBarHeight: 64,
  floatingBarInset: 88,
} as const;
