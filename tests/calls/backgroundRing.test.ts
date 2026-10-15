import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __bgRing, needsBackgroundRing, startBackgroundRing, stopBackgroundRing } from "../../src/lib/calls/backgroundRing";
import { setAppLocked, appVisible, appLocked } from "../../src/lib/realtime";

beforeEach(() => {
  __bgRing.reset();
  setAppLocked(false);
});

test("needsBackgroundRing follows appVisible / App Lock", () => {
  // jsdom/node: document may be undefined → appVisible() true
  if (typeof document === "undefined") {
    assert.equal(needsBackgroundRing(), false);
    setAppLocked(true);
    assert.equal(appLocked(), true);
    assert.equal(appVisible(), false);
    assert.equal(needsBackgroundRing(), true);
    setAppLocked(false);
    assert.equal(needsBackgroundRing(), false);
  }
});

test("start/stop background ring tracks active call id", () => {
  const posts: unknown[] = [];
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hadWindow = "window" in globalThis;
  // startBackgroundRing is a no-op without window (SSR guard); give it a minimal browser surface.
  if (!hadWindow) (globalThis as unknown as { window: unknown }).window = globalThis;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { controller: { postMessage: (m: unknown) => posts.push(m) } } },
  });
  try {
    startBackgroundRing({ callId: "c1", name: "Bea", video: false, expiresAt: Date.now() + 10_000 });
    assert.equal(__bgRing.getActive()?.callId, "c1");
    assert.ok(posts.some((p) => (p as { type?: string }).type === __bgRing.SW_START));
    stopBackgroundRing("c1");
    assert.equal(__bgRing.getActive(), null);
    assert.ok(posts.some((p) => (p as { type?: string }).type === __bgRing.SW_STOP));
  } finally {
    if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
    __bgRing.reset();
  }
});

test("SW message constants are stable for the service worker contract", () => {
  assert.equal(__bgRing.SW_START, "openlounge:call-ring-start");
  assert.equal(__bgRing.SW_STOP, "openlounge:call-ring-stop");
  assert.ok(__bgRing.SW_TICK_MS >= 1000);
});
