import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Id, PromiseMemory } from '../../../shared/contracts';

/**
 * Promises are the only thing Amelia interrupts you for. When a promise or reminder
 * arrives carrying a due date, we schedule a local notification for it — no push
 * infrastructure, no server round trip.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let permissionGranted: boolean | null = null;

export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('promises', {
      name: 'Promises',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  }
  const existing = await Notifications.getPermissionsAsync();
  const status = existing.granted
    ? existing
    : await Notifications.requestPermissionsAsync();
  permissionGranted = status.granted;
  return permissionGranted;
}

const scheduled = new Map<Id, string>();

export async function schedulePromiseNotification(
  promise: Pick<PromiseMemory, '_id' | 'text' | 'due_at' | 'status'>,
  personName: string,
): Promise<string | null> {
  if (!promise.due_at || promise.status !== 'open') return null;
  if (scheduled.has(promise._id)) return scheduled.get(promise._id) ?? null;

  const fireAt = new Date(promise.due_at);
  if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= Date.now() + 1_000) return null;

  const granted = await ensureNotificationPermission();
  if (!granted) return null;

  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title: `${personName} owes you something`,
      body: promise.text,
      data: { promise_id: promise._id },
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fireAt,
      channelId: Platform.OS === 'android' ? 'promises' : undefined,
    },
  });
  scheduled.set(promise._id, identifier);
  return identifier;
}

export async function cancelPromiseNotification(promiseId: Id): Promise<void> {
  const identifier = scheduled.get(promiseId);
  if (!identifier) return;
  scheduled.delete(promiseId);
  await Notifications.cancelScheduledNotificationAsync(identifier);
}
