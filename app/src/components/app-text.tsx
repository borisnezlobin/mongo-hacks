import { Text, type TextProps, type TextStyle } from 'react-native';
import { colors, typography, type TextVariant } from '../constants/theme';

interface AppTextProps extends TextProps {
  variant?: TextVariant;
  color?: string;
  align?: TextStyle['textAlign'];
}

export function AppText({ variant = 'body', color, align, style, ...rest }: AppTextProps) {
  return (
    <Text
      {...rest}
      style={[typography[variant], color ? { color } : null, align ? { textAlign: align } : null, style]}
    />
  );
}

export function MutedText(props: AppTextProps) {
  return <AppText variant="label" color={colors.inkMuted} {...props} />;
}
