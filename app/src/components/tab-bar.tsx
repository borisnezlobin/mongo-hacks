import { Pressable, StyleSheet, View } from 'react-native';
import { HandshakeIcon, HouseSimpleIcon, UsersThreeIcon } from 'phosphor-react-native';
import type { Icon } from 'phosphor-react-native';
import { AppText } from './app-text';
import { colors, layout, radii, shadows, spacing } from '../constants/theme';

export type TabKey = 'home' | 'people' | 'loops';

const TABS: { key: TabKey; label: string; icon: Icon }[] = [
  { key: 'home', label: 'Home', icon: HouseSimpleIcon },
  { key: 'people', label: 'People', icon: UsersThreeIcon },
  { key: 'loops', label: 'Loops', icon: HandshakeIcon },
];

interface TabBarProps {
  active: TabKey;
  onChange(tab: TabKey): void;
  badges?: Partial<Record<TabKey, number>>;
  bottomInset: number;
}

export function TabBar({ active, onChange, badges, bottomInset }: TabBarProps) {
  return (
    <View style={[styles.container, { paddingBottom: Math.max(bottomInset, spacing.sm) }]}>
      {TABS.map(({ key, label, icon: IconComponent }) => {
        const selected = key === active;
        const tone = selected ? colors.accent : colors.inkFaint;
        const badge = badges?.[key] ?? 0;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(key)}
            style={styles.tab}
          >
            <View>
              <IconComponent size={23} color={tone} weight={selected ? 'fill' : 'regular'} />
              {badge > 0 ? (
                <View style={styles.badge}>
                  <AppText variant="caption" color={colors.inkInverse} style={styles.badgeText}>
                    {badge > 9 ? '9+' : String(badge)}
                  </AppText>
                </View>
              ) : null}
            </View>
            <AppText variant="caption" color={tone}>{label}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    paddingTop: spacing.md,
    minHeight: layout.tabBarHeight,
    ...shadows.floating,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.live,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10, lineHeight: 13 },
});
