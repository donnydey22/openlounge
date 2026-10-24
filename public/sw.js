/* Open Lounge service worker — notifications ONLY.
 *
 * Pages are network-first (online the app always loads fresh); the last copy of the inbox / chat
 * screens and the hashed build files are kept only so the app opens with no signal (offline inbox).
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
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // drop app-shell caches from older versions
      typeof caches === "undefined"
        ? null
        : caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("ol-shell-") && k !== SHELL_PAGES && k !== SHELL_STATIC).map((k) => caches.delete(k)))),
    ]),
  );
});

/* ======================================================================================
 * OFFLINE APP SHELL (offline inbox: opening the app with no signal)
 * Online behaviour is unchanged: pages are NETWORK-FIRST (always fresh; the copy is only refreshed),
 * and only when the network fails is the last copy of that page (or the inbox) served. Hashed build
 * files (/_next/static, immutable) are cache-first. Nothing else is touched: API, WebSocket, media,
 * uploads and auth all go straight to the network. No user data lives here (chats are in IndexedDB,
 * per signed-in user, wiped on sign-out).
 * ====================================================================================== */
var SHELL_PAGES = "ol-shell-pages-v1";
var SHELL_STATIC = "ol-shell-static-v1";
var SHELL_STATIC_MAX = 400;
var SHELL_ROUTES = /^\/(messages(\/[^/]+)?|calls|settings)?\/?$/;

function shellTrim(cache, max) {
  return cache.keys().then(function (keys) {
    if (keys.length <= max) return;
    return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return cache.delete(k); }));
  });
}

// The inbox asks for its top chats' screens to be kept (only while online), so a chat never opened by a full
// page load still opens with no signal. Same-origin paths matching SHELL_ROUTES only; at most 30 per message.
self.addEventListener("message", (event) => {
  var d = event.data;
  if (!d || d.type !== "ol-shell-warm" || !Array.isArray(d.paths) || typeof caches === "undefined") return;
  var origin = self.location.origin;
  var paths = d.paths.filter(function (x) { return typeof x === "string" && SHELL_ROUTES.test(x); }).slice(0, 30);
  var job = caches.open(SHELL_PAGES).then(function (c) {
    return paths.reduce(function (chain, path) {
      return chain.then(function () {
        return c.match(origin + path).then(function (hit) {
          if (hit) return;
          return fetch(origin + path, { credentials: "same-origin" }).then(function (res) {
            if (res && res.ok && res.type === "basic" && !res.redirected) return c.put(origin + path, res);
          }).catch(function () {});
        });
      });
    }, Promise.resolve()).then(function () { return shellTrim(c, 80); });
  });
  if (event.waitUntil) event.waitUntil(job);
});

self.addEventListener("fetch", (event) => {
  var req = event.request;
  if (req.method !== "GET" || typeof caches === "undefined") return;
  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && SHELL_ROUTES.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          if (res && res.ok && res.type === "basic" && !res.redirected) {
            var copy = res.clone();
            var key = url.origin + url.pathname; // no query: one copy per screen
            event.waitUntil(caches.open(SHELL_PAGES).then(function (c) { return c.put(key, copy); }).catch(function () {}));
          }
          return res;
        })
        .catch(function (err) {
          return caches.open(SHELL_PAGES).then(function (c) {
            return c.match(url.origin + url.pathname).then(function (hit) {
              // an unseen chat / screen with no signal: the inbox (it routes client-side from there)
              return hit || c.match(url.origin + "/messages") || c.match(url.origin + "/") || Promise.reject(err);
            });
          });
        }),
    );
    return;
  }
  if (url.pathname.indexOf("/_next/static/") === 0) {
    event.respondWith(
      caches.open(SHELL_STATIC).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && res.ok && res.type === "basic") {
              var copy = res.clone();
              event.waitUntil(c.put(req, copy).then(function () { return shellTrim(c, SHELL_STATIC_MAX); }).catch(function () {}));
            }
            return res;
          });
        });
      }),
    );
  }
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
