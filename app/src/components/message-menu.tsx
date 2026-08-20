import { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { Icon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, radii, spacing } from '../constants/theme';

export interface MenuAction {
  label: string;
  icon: Icon;
  destructive?: boolean;
  run(): void;
}

/** Where the pressed row sits on screen, in window coordinates. */
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MessageMenuProps {
  anchor: Anchor | null;
  speaker: string;
  text: string;
  actions: MenuAction[];
  onDismiss(): void;
}

const ROW_HEIGHT = 48;
const GAP = spacing.sm;
const MARGIN = spacing.lg;
/** Clears the home indicator, which Dimensions.get('window') counts as usable. */
const BOTTOM_MARGIN = spacing.xxxl;
const MAX_PREVIEW = 220;

/**
 * The long-press menu every messaging app has: the rest of the screen recedes,
 * the message you pressed stays exactly where it was, and the actions open
 * beneath it.
 *
 * Keeping the message in place is the whole point — it is what tells you which
 * message you are about to act on. An alert sheet detaches the menu from its
 * subject and makes you remember which row you pressed.
 *
 * Built on core Modal/Animated deliberately: expo-blur and gesture-handler are
 * not in the native build, and adding either means rebuilding the dev client.
 * A dim scrim reads correctly in a light-mode app anyway.
 */
export function MessageMenu({ anchor, speaker, text, actions, onDismiss }: MessageMenuProps) {
  const entrance = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!anchor) {
      entrance.setValue(0);
      return;
    }
    Animated.timing(entrance, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [anchor, entrance]);

  if (!anchor) return null;

  const screen = Dimensions.get('window');
  const menuHeight = actions.length * ROW_HEIGHT + spacing.sm * 2;
  const previewHeight = Math.min(anchor.height, MAX_PREVIEW);

  // The actions always sit below the message — flipping them above it changes
  // which row each action lines up with and reads as a different menu. So when
  // the pair would run off the bottom, the *message* slides up instead, by
  // exactly as much as it takes and no more, keeping it near where it was.
  const lowestTop = screen.height - BOTTOM_MARGIN - menuHeight - GAP - previewHeight;
  const previewTop = Math.max(MARGIN, Math.min(anchor.y, lowestTop));

  const left = Math.max(MARGIN, Math.min(anchor.x, screen.width - anchor.width - MARGIN));
  const width = Math.min(anchor.width, screen.width - MARGIN * 2);

  return (
    <Modal transparent visible animationType="none" onRequestClose={onDismiss}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} accessibilityLabel="Dismiss menu">
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: entrance }]} />
      </Pressable>

      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.group,
          {
            top: previewTop,
            left,
            width,
            opacity: entrance,
            transform: [
              // Start where the row actually is and rise into place, so a message
              // that has to move up is seen moving rather than teleporting.
              { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [anchor.y - previewTop, 0] }) },
              { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
            ],
          },
        ]}
      >
        <View style={[styles.preview, { maxHeight: MAX_PREVIEW }]}>
          <AppText variant="caption" color={colors.inkMuted}>{speaker}</AppText>
          <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
            <AppText variant="body">{text}</AppText>
          </ScrollView>
        </View>

        <View style={styles.menu}>
          {actions.map((action, index) => (
            <Pressable
              key={action.label}
              onPress={() => { onDismiss(); action.run(); }}
              style={({ pressed }) => [
                styles.action,
                index > 0 && styles.actionDivided,
                pressed && styles.actionPressed,
              ]}
            >
              <action.icon
                size={18}
                color={action.destructive ? colors.accent : colors.ink}
                weight="regular"
              />
              <AppText variant="body" color={action.destructive ? colors.accent : colors.ink}>
                {action.label}
              </AppText>
            </Pressable>
          ))}
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: colors.scrim },
  group: { position: 'absolute', gap: GAP },
  preview: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: 2,
    // Shadow rather than a border: a visible-colour border on a rounded corner
    // anti-aliases unevenly and reads as cut off.
    shadowColor: '#0b1220',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  menu: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    paddingVertical: spacing.sm,
    overflow: 'hidden',
    shadowColor: '#0b1220',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  action: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  actionDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  actionPressed: { backgroundColor: colors.canvasSunken },
});
