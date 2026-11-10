// Composer + live-room tray + iOS keyboard (visualViewport + focus).
// Captures before/after renders proving the composer docks to the keyboard
// whether or not a room tray is active, and sits just above the tray when
// the keyboard is closed.
//
// Run: SHOTS=/workspace/ol-composer-tray node tests/e2e/composer-tray-keyboard.render.mjs
import pw from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.env.SHOTS || "/workspace/ol-composer-tray";
mkdirSync(OUT, { recursive: true });

const W = 390;
const H = 844; // iPhone 14 / 15 logical viewport
const SAB = 34;
const KB = 336; // iOS keyboard (keys); accessory is included in visualViewport shrink
const ACCESSORY = 48;
const KB_TOTAL = KB + ACCESSORY; // 384: keyboard + suggestion/emoji accessory bar

const cssShared = (sab) => `
  :root { --sab: ${sab}px; --sat: 47px; --ol-liveroom-bar-h: 0px; --ol-vvh: 100dvh; --ol-vv-top: 0px; }
  html, body { margin: 0; height: 100%; background: #09090b; color: #fff; font-family: ui-sans-serif, system-ui, sans-serif; }
  html, body { overflow: clip; }
  .app-shell {
    position: fixed; inset-inline: 0; top: var(--ol-vv-top, 0px);
    height: var(--ol-vvh, 100dvh); overflow: hidden;
  }
  html[data-live-room-bar] { --ol-liveroom-bar-h: calc(4.5rem + var(--sab)); }
  html[data-live-room-bar] .app-shell {
    padding-bottom: var(--ol-liveroom-bar-h);
    scroll-padding-bottom: var(--ol-liveroom-bar-h);
  }
  html[data-live-room-bar] [data-ol-screen] {
    padding-bottom: var(--ol-liveroom-bar-h);
    box-sizing: border-box;
  }
  html[data-live-room-bar] [data-ol-screen] [data-ol-bottom-pad] {
    padding-bottom: 0.5rem !important;
  }
  /* keyboard chrome (not part of the page; we draw it as an overlay for screenshots) */
  .kb-overlay {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 200;
    background: #d1d1d6; color: #111; display: none; pointer-events: none;
    font-size: 13px; box-shadow: 0 -1px 0 rgba(0,0,0,.15);
  }
  .kb-overlay .acc {
    height: ${ACCESSORY}px; display: flex; align-items: center; justify-content: center;
    background: #ececec; border-bottom: 1px solid #c8c8cc; letter-spacing: .2em;
  }
  .kb-overlay .keys {
    height: ${KB}px; display: flex; align-items: center; justify-content: center;
    font-weight: 600;
  }
  html[data-kbd] .kb-overlay { display: block; }
  .screen {
    position: fixed; inset-inline: 0; top: 0; z-index: 10; background: #09090b;
    display: flex; flex-direction: column;
  }
  .hdr {
    flex: 0 0 auto; height: calc(56px + var(--sat)); padding-top: var(--sat);
    display: flex; align-items: center; gap: 10px; padding-left: 16px;
    border-bottom: 1px solid rgba(255,255,255,.06); font-weight: 600;
  }
  .av { width: 32px; height: 32px; border-radius: 16px; background: #3f3f46; }
  .list { flex: 1; overflow: auto; padding: 12px 16px; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; }
  .bubble { align-self: flex-start; max-width: 70%; background: #27272a; border-radius: 16px; padding: 8px 12px; font-size: 15px; }
  .bubble.me { align-self: flex-end; background: #059669; }
  .composer {
    flex: 0 0 auto; border-top: 1px solid rgba(255,255,255,.06);
    padding: 8px 12px; padding-bottom: max(0.5rem, var(--sab));
    display: flex; gap: 8px; align-items: flex-end; background: #09090b;
  }
  .composer input {
    flex: 1; height: 40px; border-radius: 20px; border: 0; background: #27272a;
    color: #fff; padding: 0 14px; font-size: 16px;
  }
  .composer button { height: 40px; width: 40px; border-radius: 20px; border: 0; background: #10b981; color: #052e16; font-weight: 700; }
  #live-room-bar {
    position: fixed; inset-inline: 0; bottom: 0; z-index: 70;
    padding: 0 8px; padding-bottom: max(0.5rem, var(--sab));
    display: none;
  }
  html[data-live-room-bar] #live-room-bar { display: block; }
  #live-room-bar .inner {
    display: flex; align-items: center; gap: 8px;
    border: 1px solid rgba(52,211,153,.3); background: rgba(9,9,11,.95);
    border-radius: 16px; padding: 8px; box-shadow: 0 20px 40px rgba(0,0,0,.4);
  }
  #live-room-bar .icon { width: 36px; height: 36px; border-radius: 18px; background: #059669; flex: 0 0 auto; }
  #live-room-bar .txt { flex: 1; min-width: 0; }
  #live-room-bar .txt b { display: block; font-size: 13px; }
  #live-room-bar .txt span { display: block; font-size: 11px; color: #a1a1aa; }
  .gap-flag {
    position: fixed; z-index: 150; pointer-events: none;
    border: 1.5px dashed #f43f5e; background: rgba(244,63,94,.18);
    display: none;
  }
`;

const cssAfter = `
  html[data-kbd][data-live-room-bar] { --ol-liveroom-bar-h: 0px !important; }
  html[data-kbd][data-live-room-bar] [data-ol-screen] [data-ol-bottom-pad] {
    padding-bottom: max(0.5rem, var(--sab)) !important;
  }
  html[data-kbd] [data-ol-live-room-bar] {
    visibility: hidden; pointer-events: none;
  }
`;

const bodyHtml = `
  <div class="app-shell" id="app-shell"></div>
  <div class="screen" data-ol-screen id="screen">
    <div class="hdr"><div class="av"></div>Keiko</div>
    <div class="list">
      <div class="bubble">Hey, are you around?</div>
      <div class="bubble me">On my way — give me two minutes</div>
      <div class="bubble">Okay, I'll wait here</div>
    </div>
    <div class="composer" data-ol-bottom-pad data-testid="composer">
      <input data-testid="composer-input" id="composer-input" placeholder="Message Keiko…"/>
      <button type="button">➤</button>
    </div>
  </div>
  <div id="live-room-bar" data-ol-live-room-bar data-testid="live-room-bar">
    <div class="inner">
      <div class="icon"></div>
      <div class="txt"><b>Drop-in with Keiko</b><span>Live audio continues</span></div>
    </div>
  </div>
  <div class="kb-overlay" id="kb-overlay" aria-hidden="true">
    <div class="acc">✧  ⌫  😊  🎤</div>
    <div class="keys">keyboard</div>
  </div>
  <div class="gap-flag" id="gap-flag"></div>
`;

const bootJs = (mode) => `
(function(){
  const MODE = ${JSON.stringify(mode)};
  const KB_TOTAL = ${KB_TOTAL};
  const listeners = { resize: [], scroll: [] };
  let vvH = window.innerHeight;
  let vvTop = 0;
  const vv = {
    get height() { return vvH; },
    get width() { return window.innerWidth; },
    get offsetTop() { return vvTop; },
    get offsetLeft() { return 0; },
    get scale() { return 1; },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatch(type) { for (const fn of (listeners[type] || []).slice()) { try { fn(); } catch (e) {} } },
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, get() { return vv; } });

  const root = document.documentElement;
  const screen = document.getElementById("screen");
  const bar = document.getElementById("live-room-bar");
  let layoutH = window.innerHeight;

  const focusedField = () => {
    const a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };

  const syncShell = () => {
    const h = vv.height;
    const top = vv.offsetTop;
    const focused = focusedField();
    if (!focused) layoutH = window.innerHeight;
    const overlay = window.innerHeight - h > 80;
    const resized = focused && layoutH - window.innerHeight > 80;
    const open = overlay || resized;
    if (open) {
      root.style.setProperty("--ol-vvh", Math.round(h) + "px");
      root.style.setProperty("--ol-vv-top", Math.round(top) + "px");
      root.setAttribute("data-kbd", "");
    } else {
      root.style.removeProperty("--ol-vvh");
      root.style.removeProperty("--ol-vv-top");
      root.removeAttribute("data-kbd");
    }
  };

  const syncScreen = () => {
    screen.style.height = vv.height + "px";
    screen.style.transform = vv.offsetTop ? "translateY(" + vv.offsetTop + "px)" : "";
  };

  const syncTray = () => {
    if (!root.hasAttribute("data-live-room-bar")) {
      root.style.removeProperty("--ol-liveroom-bar-h");
      bar.style.bottom = "0px";
      return;
    }
    const height = Math.ceil(bar.getBoundingClientRect().height);
    const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (MODE === "before") {
      root.style.setProperty("--ol-liveroom-bar-h", height + "px");
      bar.style.bottom = keyboard + "px";
    } else {
      const kbdOpen = keyboard > 80 || root.hasAttribute("data-kbd");
      root.style.setProperty("--ol-liveroom-bar-h", kbdOpen ? "0px" : height + "px");
      bar.style.bottom = "0px";
    }
  };

  const apply = () => { syncShell(); syncScreen(); syncTray(); };

  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  document.addEventListener("focusin", apply, true);
  document.addEventListener("focusout", apply, true);

  window.__olSetTray = (on) => {
    if (on) root.setAttribute("data-live-room-bar", "");
    else {
      root.removeAttribute("data-live-room-bar");
      root.style.removeProperty("--ol-liveroom-bar-h");
    }
    apply();
  };

  // iOS overlay keyboard: innerHeight stays tall; visualViewport shrinks.
  // offsetTop=0 is the common case; offsetTop>0 is the iOS pan-to-field case
  // that used to leave the tray behind the keyboard while padding still applied.
  window.__olOpenKeyboard = ({ offsetTop = 0 } = {}) => {
    const input = document.getElementById("composer-input");
    input.focus();
    vvH = window.innerHeight - KB_TOTAL;
    vvTop = offsetTop;
    // If iOS panned, the visible band starts at offsetTop and has height vvH.
    // Keep height so vvH + offsetTop <= innerHeight (the typical pan case
    // uses offsetTop ≈ keyboard, height ≈ innerHeight - keyboard, which would
    // overflow; clamp so the visible area stays above the keyboard).
    if (vvH + vvTop > window.innerHeight) vvH = window.innerHeight - vvTop;
    // A common buggy reporting: height already shrunk AND offsetTop set to the
    // keyboard cover. In that case keyboard-calc (innerHeight - h - offsetTop) is 0.
    apply();
    vv.dispatch("resize");
    vv.dispatch("scroll");
  };

  window.__olCloseKeyboard = () => {
    const input = document.getElementById("composer-input");
    input.blur();
    vvH = window.innerHeight;
    vvTop = 0;
    apply();
    vv.dispatch("resize");
    vv.dispatch("scroll");
  };

  window.__olMeasure = () => {
    const input = document.getElementById("composer-input");
    const composer = document.querySelector("[data-testid=composer]");
    const c = composer.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    const barOn = root.hasAttribute("data-live-room-bar");
    const barR = barOn ? bar.getBoundingClientRect() : null;
    const hidden = barOn && getComputedStyle(bar).visibility === "hidden";
    const vvBottom = vv.offsetTop + vv.height;
    const gap = Math.round((vvBottom - c.bottom) * 10) / 10;
    return {
      mode: MODE,
      kbd: root.hasAttribute("data-kbd"),
      tray: barOn,
      trayHidden: !!hidden,
      composer: { top: c.top, bottom: c.bottom, height: c.height },
      input: { top: i.top, bottom: i.bottom, height: i.height },
      trayRect: barR ? { top: barR.top, bottom: barR.bottom, height: barR.height } : null,
      vv: { height: vv.height, offsetTop: vv.offsetTop, bottom: vvBottom },
      innerHeight: window.innerHeight,
      reserved: getComputedStyle(root).getPropertyValue("--ol-liveroom-bar-h").trim(),
      gapToKeyboard: gap,
    };
  };

  apply();
})();
`;

function pageHtml(mode) {
  return `<!doctype html><html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
    <style>${cssShared(SAB)}${mode === "after" ? cssAfter : ""}</style>
  </head>
  <body>${bodyHtml}<script>${bootJs(mode)}</script></body>
</html>`;
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

const cases = [
  { id: "tray-off-kbd-closed", tray: false, kbd: false, offsetTop: 0, label: "no tray, keyboard closed" },
  { id: "tray-on-kbd-closed", tray: true, kbd: false, offsetTop: 0, label: "tray on, keyboard closed" },
  { id: "tray-off-kbd-open", tray: false, kbd: true, offsetTop: 0, label: "no tray, keyboard open (focus)" },
  { id: "tray-on-kbd-open", tray: true, kbd: true, offsetTop: 0, label: "tray on, keyboard open (focus)" },
  { id: "tray-on-kbd-open-pan", tray: true, kbd: true, offsetTop: 24, label: "tray on, keyboard open, iOS offsetTop pan" },
];

const report = [];
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) fail++;
};

const br = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
for (const mode of ["before", "after"]) {
  const ctx = await br.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();
  await page.setContent(pageHtml(mode), { waitUntil: "load" });

  for (const c of cases) {
    await page.evaluate(({ tray, kbd, offsetTop }) => {
      window.__olSetTray(tray);
      if (kbd) window.__olOpenKeyboard({ offsetTop });
      else window.__olCloseKeyboard();
    }, c);

    // Reproduce Donny's path: focusing the composer is what opens the keyboard.
    if (c.kbd) {
      await page.focus("[data-testid=composer-input]");
      await page.evaluate(({ offsetTop }) => window.__olOpenKeyboard({ offsetTop }), c);
    }

    const m = await page.evaluate(() => window.__olMeasure());

    // Highlight the empty gap (composer bottom → visual viewport bottom) when it's large.
    await page.evaluate((meas) => {
      const flag = document.getElementById("gap-flag");
      const c = meas.composer;
      const vvBottom = meas.vv.bottom;
      const gap = vvBottom - c.bottom;
      // Only flag the keyboard-open empty gap (the reported bug). When the
      // keyboard is closed the reserved tray strip is intentional, not a gap.
      if (meas.kbd && gap > 16) {
        flag.style.display = "block";
        flag.style.left = "0px";
        flag.style.width = "100%";
        flag.style.top = c.bottom + "px";
        flag.style.height = Math.max(0, gap) + "px";
      } else {
        flag.style.display = "none";
      }
    }, m);

    const shot = `${OUT}/${mode}-${c.id}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    report.push({ mode, case: c.id, label: c.label, shot, ...m });
    console.log(mode, c.id, JSON.stringify({
      gap: m.gapToKeyboard,
      reserved: m.reserved,
      kbd: m.kbd,
      trayHidden: m.trayHidden,
      composerBottom: Math.round(m.composer.bottom),
      vvBottom: Math.round(m.vv.bottom),
    }));
  }
  await ctx.close();
}
await br.close();

// Assertions on the captured measurements
const get = (mode, id) => report.find((r) => r.mode === mode && r.case === id);

const afterOffOpen = get("after", "tray-off-kbd-open");
const afterOnOpen = get("after", "tray-on-kbd-open");
const afterOnOpenPan = get("after", "tray-on-kbd-open-pan");
const afterOnClosed = get("after", "tray-on-kbd-closed");
const afterOffClosed = get("after", "tray-off-kbd-closed");
const beforeOnOpen = get("before", "tray-on-kbd-open");
const beforeOffOpen = get("before", "tray-off-kbd-open");

check("after: keyboard+no tray, composer docks near visual viewport bottom",
  afterOffOpen.gapToKeyboard >= -2 && afterOffOpen.gapToKeyboard <= 16,
  `gap=${afterOffOpen.gapToKeyboard}`);

check("after: keyboard+tray, composer docks near visual viewport bottom",
  afterOnOpen.gapToKeyboard >= -2 && afterOnOpen.gapToKeyboard <= 16,
  `gap=${afterOnOpen.gapToKeyboard}`);

check("after: keyboard+tray matches keyboard+no tray (within 4px)",
  Math.abs(afterOnOpen.composer.bottom - afterOffOpen.composer.bottom) <= 4,
  `${afterOnOpen.composer.bottom} vs ${afterOffOpen.composer.bottom}`);

check("after: iOS pan (offsetTop) also docks to the keyboard, no stacked gap",
  afterOnOpenPan.gapToKeyboard >= -2 && afterOnOpenPan.gapToKeyboard <= 16,
  `gap=${afterOnOpenPan.gapToKeyboard}`);

check("after: keyboard+tray hides the tray so it cannot cover the composer",
  afterOnOpen.trayHidden === true, String(afterOnOpen.trayHidden));

if (afterOnClosed.trayRect) {
  const overlap = afterOnClosed.composer.bottom > afterOnClosed.trayRect.top + 1;
  const gap = afterOnClosed.trayRect.top - afterOnClosed.composer.bottom;
  check("after: keyboard closed + tray, composer does not overlap the tray",
    !overlap, `composerBottom=${afterOnClosed.composer.bottom} trayTop=${afterOnClosed.trayRect.top}`);
  check("after: keyboard closed + tray, composer sits just above the tray",
    gap >= -1 && gap <= 12, `gap=${gap}`);
}

check("after: keyboard closed + no tray, composer is near the screen bottom (safe area)",
  H - afterOffClosed.composer.bottom <= SAB + 16,
  `bottom=${afterOffClosed.composer.bottom} / ${H}`);

// Document the bug in the before renders: tray height stacked on the inset.
check("before: keyboard+tray left a large empty gap (the reported bug)",
  beforeOnOpen.gapToKeyboard > 40,
  `gap=${beforeOnOpen.gapToKeyboard}`);
check("before: keyboard+no tray already docked (so the gap is tray stacking)",
  beforeOffOpen.gapToKeyboard <= 16,
  `gap=${beforeOffOpen.gapToKeyboard}`);

writeFileSync(`${OUT}/report.json`, JSON.stringify({ viewport: { W, H, SAB, KB_TOTAL }, fail, report }, null, 2));
console.log(`\nWrote ${report.length} shots to ${OUT} (${fail} failures)`);
process.exit(fail ? 1 : 0);
