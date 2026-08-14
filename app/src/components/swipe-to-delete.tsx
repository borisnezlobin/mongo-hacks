import { useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { TrashIcon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, radii, spacing } from '../constants/theme';

interface SwipeToDeleteProps {
  onDelete(): void;
  children: React.ReactNode;
}

const ACTION_WIDTH = 88;
/** Past this the gesture is a delete, not a scroll or a stray drag. */
const COMMIT = 56;
/** Horizontal travel needed before we claim the gesture from the scroll view. */
const CLAIM = 12;

/**
 * Swipe a row left to reveal delete.
 *
 * Hand-rolled on PanResponder because react-native-gesture-handler is not in
 * the native build, and adding it means rebuilding the dev client. The one
 * subtlety is claiming the gesture: the row sits in a vertical ScrollView, so
 * it must only take over once the drag is clearly horizontal, or the list stops
 * scrolling.
 */
export function SwipeToDelete({ onDelete, children }: SwipeToDeleteProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const open = useRef(false);

  const settle = (toValue: number) => {
    open.current = toValue !== 0;
    Animated.spring(translateX, { toValue, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
  };

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > CLAIM && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderMove: (_event, gesture) => {
        const base = open.current ? -ACTION_WIDTH : 0;
        // Rightward drag past closed does nothing; there is no action there.
        translateX.setValue(Math.min(0, Math.max(-ACTION_WIDTH - 24, base + gesture.dx)));
      },
      onPanResponderRelease: (_event, gesture) => {
        const base = open.current ? -ACTION_WIDTH : 0;
        settle(base + gesture.dx < -COMMIT ? -ACTION_WIDTH : 0);
      },
      onPanResponderTerminate: () => settle(open.current ? -ACTION_WIDTH : 0),
    }),
  ).current;

  return (
    <View style={styles.container}>
      {/* The action sits behind the row. Sliding the row left exposes it, and
          it is a real button there — no pointerEvents juggling needed. */}
      <View style={styles.actionLayer}>
        <Pressable
          onPress={() => { settle(0); onDelete(); }}
          style={styles.actionPress}
          accessibilityLabel="Delete conversation"
        >
          <Animated.View
            style={[styles.action, { opacity: translateX.interpolate({
              inputRange: [-ACTION_WIDTH, -COMMIT, 0],
              outputRange: [1, 0.6, 0],
            }) }]}
          >
            <TrashIcon size={18} color={colors.inkInverse} weight="regular" />
            <AppText variant="caption" color={colors.inkInverse}>Delete</AppText>
          </Animated.View>
        </Pressable>
      </View>

      <Animated.View style={{ transform: [{ translateX }] }} {...responder.panHandlers}>
        <View style={styles.row}>{children}</View>
      </Animated.View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative' },
  row: { backgroundColor: colors.canvas },
  actionLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'flex-end', justifyContent: 'center' },
  action: {
    width: ACTION_WIDTH,
    height: '100%',
    borderRadius: radii.card,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  actionPress: { height: '100%', justifyContent: 'center' },
});
