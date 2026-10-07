// Push (FCM via @react-native-firebase/messaging) + notification display/taps via expo-notifications.
//
// Launch safety (0.2.5 b12): NOTHING here touches Firebase or expo-notifications at module load. The native
// modules are required lazily inside initPush(), which App.tsx calls only after the WebView's first load finished
// (+1.5 s). Every call is wrapped so a missing/broken native module or missing Firebase config just disables push.

export type PushTokenListener = (token: string) => void;

type Messaging = typeof import('@react-native-firebase/messaging');

let msgMod: Messaging | null = null;
let initDone = false;
let available = false;

function log(where: string, e: unknown) {
  try {
    console.warn(`[push] ${where} failed (ignored):`, e instanceof Error ? e.message : String(e));
  } catch {}
}

/** Firebase configured natively (GoogleService-Info.plist bundled → FirebaseApp.configure() ran)? */
function firebaseConfigured(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app = require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
    const apps = app.getApps();
    if (!apps.length) return false;
    const o = apps[0].options;
    return !!(o && o.appId && o.messagingSenderId);
  } catch (e) {
    log('firebase config check', e);
    return false;
  }
}

function messaging(): Messaging | null {
  if (!available) return null;
  return msgMod;
}

/** Call once, after the app mounted and the WebView finished its first load. Returns whether push is usable. */
export function initPush(): boolean {
  if (initDone) return available;
  initDone = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Notifications = require('expo-notifications') as typeof import('expo-notifications');
    Notifications.setNotificationHandler({
      // the server only pushes when the app isn't in the foreground; if one lands anyway, show it quietly
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
    });
  } catch (e) {
    log('setNotificationHandler', e);
  }
  if (!firebaseConfigured()) {
    log('init', 'Firebase not configured; push disabled');
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    msgMod = require('@react-native-firebase/messaging') as Messaging;
    available = true;
  } catch (e) {
    log('load messaging', e);
    return false;
  }
  try {
    const M = msgMod;
    M.setBackgroundMessageHandler(M.getMessaging(), async (m) => {
      try {
        if (m.data?.clear === '1' && typeof m.data.tag === 'string') await clearDelivered(m.data.tag);
      } catch {}
    });
  } catch (e) {
    log('setBackgroundMessageHandler', e);
  }
  return available;
}

/** Asks iOS for permission (once; later calls are no-ops) and returns the FCM token, or '' if denied/unavailable. */
export async function requestPushPermissionAndToken(): Promise<string> {
  try {
    if (!initPush()) return '';
    const M = messaging();
    if (!M) return '';
    const m = M.getMessaging();
    const status = await M.requestPermission(m);
    const ok = status === M.AuthorizationStatus.AUTHORIZED || status === M.AuthorizationStatus.PROVISIONAL;
    if (!ok) return '';
    await M.registerDeviceForRemoteMessages(m);
    return await M.getToken(m);
  } catch (e) {
    log('requestPermission/getToken', e);
    return '';
  }
}

export function onTokenRefresh(cb: PushTokenListener): () => void {
  try {
    const M = messaging();
    if (!M) return () => {};
    const unsub = M.onTokenRefresh(M.getMessaging(), (t) => {
      try {
        cb(t);
      } catch {}
    });
    return () => {
      try {
        unsub();
      } catch {}
    };
  } catch (e) {
    log('onTokenRefresh', e);
    return () => {};
  }
}

const pathOf = (data: Record<string, unknown> | undefined): string | null => {
  const u = data && typeof data.url === 'string' ? data.url : null;
  return u && u.startsWith('/') && !u.startsWith('//') && u.length <= 300 ? u : null;
};

/** Notification taps (cold start + background) → in-app path like /messages/u_1 or /room/ab12. */
export function onNotificationOpen(cb: (path: string) => void): () => void {
  try {
    const M = messaging();
    if (!M) return () => {};
    const m = M.getMessaging();
    M.getInitialNotification(m)
      .then((n) => {
        const p = pathOf(n?.data);
        if (p) cb(p);
      })
      .catch(() => {});
    const unsub = M.onNotificationOpenedApp(m, (n) => {
      const p = pathOf(n?.data);
      if (p) cb(p);
    });
    return () => {
      try {
        unsub();
      } catch {}
    };
  } catch (e) {
    log('onNotificationOpen', e);
    return () => {};
  }
}

/** "clear" data messages (DM read elsewhere): drop delivered notifications for that thread. */
export async function clearDelivered(tag: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Notifications = require('expo-notifications') as typeof import('expo-notifications');
    const list = await Notifications.getPresentedNotificationsAsync();
    for (const n of list) {
      const d = (n.request.content.data ?? {}) as Record<string, unknown>;
      if (d.tag === tag) await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch {}
}
