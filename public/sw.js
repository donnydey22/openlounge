/* Open Lounge service worker — notifications ONLY.
 *
 * Deliberately has NO fetch handler: nothing is cached, every page/JS request goes straight to
 * the network exactly as it does without a service worker, so the app always loads fresh.
 * It exists so Android Chrome (where `new Notification()` throws) can show notifications via
 * registration.showNotification(), and so clicking a notification focuses the tab and opens
 * the right room / DM.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let url = "/";
  try {
    url = new URL(data.url || "/", self.location.origin).href;
  } catch (e) {
    /* keep "/" */
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = wins.filter((c) => {
        try {
          return new URL(c.url).origin === self.location.origin;
        } catch (e) {
          return false;
        }
      });
      // prefer the tab that raised the notification, then a visible/focused one, then any
      const target =
        same.find((c) => data.clientId && c.id === data.clientId) ||
        same.find((c) => c.focused) ||
        same.find((c) => c.visibilityState === "visible") ||
        same[0];
      if (target) {
        try {
          await target.focus();
        } catch (e) {
          /* focus can be refused; still navigate */
        }
        // the page routes client-side (keeps the room's audio/WebSocket alive)
        target.postMessage({ type: "openlounge:navigate", url });
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
