/* Open Lounge service worker — notifications ONLY.
 *
 * Deliberately has NO fetch handler: nothing is cached, every page/JS request goes straight to
 * the network exactly as it does without a service worker, so the app always loads fresh.
 * It exists so Android Chrome (where `new Notification()` throws) can show notifications via
 * registration.showNotification(), and so clicking a notification focuses the tab and opens
 * the right room / DM.
 *
 * Incoming calls (hidden tab / device locked): the page posts openlounge:call-ring-start and we
 * show a persistent CATEGORY_CALL-style notification (requireInteraction, renotify, vibrate,
 * Accept / Decline) re-shown every few seconds until stop / answer / decline / expiry.
 * Browsers will not let a page keep Web Audio ringing while fully backgrounded — this notification
 * is the audible/visible fallback. See docs/calls-background-ring.md.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ======================================================================================
 * SHARED HELPERS (no feature logic)
 * ====================================================================================== */

function resolveUrl(u) {
  try {
    return new URL(u || "/", self.location.origin).href;
  } catch (e) {
    return self.location.origin + "/";
  }
}

async function pickWindow(data) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const same = wins.filter((c) => {
    try {
      return new URL(c.url).origin === self.location.origin;
    } catch (e) {
      return false;
    }
  });
  return (
    same.find((c) => data.clientId && c.id === data.clientId) ||
    same.find((c) => c.focused) ||
    same.find((c) => c.visibilityState === "visible") ||
    same[0]
  );
}

async function focusAndNavigate(data, url, extra) {
  const target = await pickWindow(data);
  if (target) {
    try {
      await target.focus();
    } catch (e) {
      /* focus can be refused; still navigate */
    }
    target.postMessage({ type: "openlounge:navigate", url });
    if (extra) target.postMessage(extra);
    return;
  }
  if (self.clients.openWindow) await self.clients.openWindow(url);
}

/* ======================================================================================
 * CALLS SECTION (calling isolation, REGRESSION_PATTERN_REPORT §5). Only call_ring
 * notifications and openlounge:call-* messages are handled here. Nothing in this section
 * reads or closes non-call (join / every-member / DM) notifications.
 * ====================================================================================== */

const CALL_TAG_PREFIX = "call:";
const RING_TICK_MS = 3000;
/** @type {Map<string, { title: string, body: string, url: string, acceptUrl: string, expiresAt: number, video: boolean, timer: number|null }>} */
const ringing = new Map();

function callTag(callId) {
  return CALL_TAG_PREFIX + callId;
}

async function showCallRing(info) {
  const tag = callTag(info.callId);
  try {
    await self.registration.showNotification(info.title || "Incoming call", {
      body: info.body || "Incoming call",
      tag,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [400, 200, 400, 200, 400],
      data: {
        url: info.url,
        acceptUrl: info.acceptUrl,
        callId: info.callId,
        kind: "call_ring",
      },
      actions: [
        { action: "accept", title: "Accept" },
        { action: "decline", title: "Decline" },
      ],
    });
  } catch (e) {
    /* actions unsupported in some browsers — retry without them */
    try {
      await self.registration.showNotification(info.title || "Incoming call", {
        body: info.body || "Incoming call",
        tag,
        renotify: true,
        requireInteraction: true,
        silent: false,
        vibrate: [400, 200, 400],
        data: { url: info.url, acceptUrl: info.acceptUrl, callId: info.callId, kind: "call_ring" },
      });
    } catch (e2) {
      /* ignore */
    }
  }
}

function armRing(info) {
  const prev = ringing.get(info.callId);
  if (prev && prev.timer) clearInterval(prev.timer);
  const tick = () => {
    const cur = ringing.get(info.callId);
    if (!cur) return;
    if (Date.now() > cur.expiresAt) {
      stopRing(info.callId);
      return;
    }
    void showCallRing(cur);
  };
  const entry = { ...info, timer: setInterval(tick, RING_TICK_MS) };
  ringing.set(info.callId, entry);
  void showCallRing(entry);
}

async function stopRing(callId) {
  if (callId) {
    const cur = ringing.get(callId);
    if (cur?.timer) clearInterval(cur.timer);
    ringing.delete(callId);
    const notes = await self.registration.getNotifications({ tag: callTag(callId) });
    for (const n of notes) n.close();
    return;
  }
  for (const [id, cur] of ringing) {
    if (cur.timer) clearInterval(cur.timer);
    ringing.delete(id);
    const notes = await self.registration.getNotifications({ tag: callTag(id) });
    for (const n of notes) n.close();
  }
}


function onCallMessage(msg) {
  if (msg.type === "openlounge:call-ring-start" && typeof msg.callId === "string") {
    armRing({
      callId: msg.callId,
      title: typeof msg.title === "string" ? msg.title : "Incoming call",
      body: typeof msg.body === "string" ? msg.body : "Incoming call",
      url: typeof msg.url === "string" ? msg.url : "/",
      acceptUrl: typeof msg.acceptUrl === "string" ? msg.acceptUrl : msg.url || "/",
      expiresAt: typeof msg.expiresAt === "number" ? msg.expiresAt : Date.now() + 45_000,
      video: !!msg.video,
    });
    return true;
  }
  if (msg.type === "openlounge:call-ring-stop") {
    void stopRing(typeof msg.callId === "string" ? msg.callId : undefined);
    return true;
  }
  return false;
}

function onCallNotificationClick(event, data, action) {
  if (data.callId) void stopRing(data.callId);
  if (action === "decline" && data.callId) {
    // Decline without focusing or opening a window: every open client gets one decline message.
    event.waitUntil(
      (async () => {
        const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of wins) {
          try {
            c.postMessage({ type: "openlounge:call-decline", callId: data.callId });
          } catch (e) {
            /* ignore */
          }
        }
      })(),
    );
    return;
  }
  if (action === "accept") {
    const url = resolveUrl(data.acceptUrl || data.url);
    event.waitUntil(focusAndNavigate(data, url, { type: "openlounge:call-accept", callId: data.callId }));
    return;
  }
  event.waitUntil(focusAndNavigate(data, resolveUrl(data.url)));
}

/* ======================================================================================
 * GENERAL NOTIFICATIONS SECTION (join notifications, every-member alerts, DMs, rooms).
 * Unchanged behavior: focus an existing tab and navigate it, else open a window.
 * ====================================================================================== */

function onGeneralNotificationClick(event, data) {
  event.waitUntil(focusAndNavigate(data, resolveUrl(data.url)));
}

/* ======================================================================================
 * DISPATCH
 * ====================================================================================== */

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  onCallMessage(msg);
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const action = event.action;
  event.notification.close();
  if (data.kind === "call_ring") return onCallNotificationClick(event, data, action);
  return onGeneralNotificationClick(event, data);
});
