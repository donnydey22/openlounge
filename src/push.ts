// Push (FCM via @react-native-firebase/messaging, so the server sends to iOS and Android the same way) and
// notification display/taps via expo-notifications. NOT BUILT YET — needs an APNs auth key uploaded to Firebase
// (Project settings → Cloud Messaging → Apple app configuration) and an EAS build with the aps-environment entitlement.
import {
  AuthorizationStatus,
  getInitialNotification,
  getMessaging,
  getToken,
  onNotificationOpenedApp,
  onTokenRefresh as fcmOnTokenRefresh,
  registerDeviceForRemoteMessages,
  requestPermission,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';

export type PushTokenListener = (token: string) => void;

Notifications.setNotificationHandler({
  // the server only pushes when the app isn't in the foreground; if one lands anyway, show it quietly
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/** Asks iOS for permission (once; later calls are no-ops) and returns the FCM token, or '' if denied. */
export async function requestPushPermissionAndToken(): Promise<string> {
  try {
    const m = getMessaging();
    const status = await requestPermission(m);
    const ok = status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL;
    if (!ok) return '';
    await registerDeviceForRemoteMessages(m);
    return await getToken(m);
  } catch {
    return '';
  }
}

export function onTokenRefresh(cb: PushTokenListener): () => void {
  return fcmOnTokenRefresh(getMessaging(), cb);
}

const pathOf = (data: Record<string, unknown> | undefined): string | null => {
  const u = data && typeof data.url === 'string' ? data.url : null;
  return u && u.startsWith('/') && !u.startsWith('//') && u.length <= 300 ? u : null;
};

/** Notification taps (cold start + background) → in-app path like /messages/u_1 or /room/ab12. */
export function onNotificationOpen(cb: (path: string) => void): () => void {
  getInitialNotification(getMessaging())
    .then((m) => {
      const p = pathOf(m?.data);
      if (p) cb(p);
    })
    .catch(() => {});
  const unsub = onNotificationOpenedApp(getMessaging(), (m) => {
    const p = pathOf(m?.data);
    if (p) cb(p);
  });
  return unsub;
}

/** "clear" data messages (DM read elsewhere): drop delivered notifications for that thread. */
export async function clearDelivered(tag: string) {
  try {
    const list = await Notifications.getPresentedNotificationsAsync();
    for (const n of list) {
      const d = (n.request.content.data ?? {}) as Record<string, unknown>;
      if (d.tag === tag) await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch {}
}

setBackgroundMessageHandler(getMessaging(), async (m) => {
  if (m.data?.clear === '1' && typeof m.data.tag === 'string') await clearDelivered(m.data.tag);
});
