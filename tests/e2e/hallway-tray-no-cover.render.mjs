/**
 * Hallway tray overlap audit (Playwright).
 * Usage: MODE=before|after node scripts/hallway-tray-audit.mjs
 * Screenshots + report → /workspace/hallway-tray-audit/$MODE
 */
import pw from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

// Layout reservation for the persistent live-room (hallway) tray.
// Run: node tests/e2e/hallway-tray-no-cover.render.mjs
// Optional: MODE=before to snapshot the pre-fix overlap baseline.
const MODE = process.env.MODE === "before" ? "before" : "after";
const OUT = process.env.OUT || `/workspace/hallway-tray-audit/${MODE}`;
mkdirSync(OUT, { recursive: true });
const SIZES = [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const SAB = { 375: 34, 412: 24, 820: 20, 1280: 0 };

const cssFor = (sab, mode) => `
  :root { --sab: ${sab}px; --ol-liveroom-bar-h: 0px; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #09090b; color: #fff; font: 14px/1.3 system-ui, sans-serif; height: 100%; overflow: hidden; }
  .app-shell { position: fixed; inset-inline: 0; top: 0; height: 100dvh; overflow-y: auto; }
  /* production before: only .app-shell is padded */
  html[data-live-room-bar] .app-shell { padding-bottom: calc(4.5rem + var(--sab)); }
  ${mode === "after" ? `
  html[data-live-room-bar] { --ol-liveroom-bar-h: calc(4.5rem + var(--sab)); }
  html[data-live-room-bar] .app-shell {
    padding-bottom: var(--ol-liveroom-bar-h);
    scroll-padding-bottom: var(--ol-liveroom-bar-h);
  }
  html[data-live-room-bar] [data-ol-screen] { padding-bottom: var(--ol-liveroom-bar-h); }
  html[data-live-room-bar] [data-ol-screen] [data-ol-bottom-pad] { padding-bottom: 0.5rem !important; }
  html[data-live-room-bar] [data-ol-bottom-dock] {
    bottom: var(--ol-liveroom-bar-h) !important;
    padding-bottom: 1.25rem !important;
  }
  html[data-live-room-bar] [data-ol-sheet] {
    padding-bottom: var(--ol-liveroom-bar-h);
    box-sizing: border-box;
  }
  html[data-live-room-bar] [data-ol-notif] {
    bottom: var(--ol-liveroom-bar-h) !important;
    padding-bottom: 1rem !important;
  }
  ` : ""}

  .main { padding: 16px; padding-bottom: 8rem; }
  .card { height: 120px; margin-bottom: 12px; background: #18181b; border-radius: 16px; }
  .dock {
    position: fixed; inset-inline: 0; bottom: 0; z-index: 30;
    display: flex; justify-content: center;
    padding-bottom: max(1.25rem, var(--sab)); padding-top: 2.5rem;
    background: linear-gradient(to top, #09090b, transparent); pointer-events: none;
  }
  .dock button {
    pointer-events: auto; background: #10b981; color: #052e16; border: 0;
    border-radius: 999px; padding: 14px 24px; font-weight: 600;
  }

  .screen-dm, .screen-group {
    position: fixed; inset-inline: 0; top: 0; height: 100dvh; z-index: 10;
    display: flex; flex-direction: column; background: #09090b;
  }
  .hdr { height: 56px; border-bottom: 1px solid #27272a; display: flex; align-items: center; padding: 0 12px; flex-shrink: 0; }
  .list { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
  .bubble { max-width: 70%; background: #27272a; padding: 8px 12px; border-radius: 16px; margin: 6px 0; }
  .composer {
    flex-shrink: 0; border-top: 1px solid #27272a; padding: 8px 12px;
    padding-bottom: max(0.5rem, var(--sab)); display: flex; gap: 8px; align-items: flex-end;
  }
  .composer input { flex: 1; height: 40px; border-radius: 20px; border: 0; background: #27272a; color: #fff; padding: 0 14px; }
  .composer button { height: 40px; width: 40px; border-radius: 20px; border: 0; background: #10b981; }
  .group-footer {
    flex-shrink: 0; border-top: 1px solid #27272a; padding: 12px 16px;
    padding-bottom: max(0.75rem, var(--sab));
  }
  .group-footer button { width: 100%; height: 44px; border-radius: 999px; border: 0; background: #10b981; font-weight: 600; }

  .sheet-overlay {
    position: fixed; inset-inline: 0; top: 0; height: 100dvh; z-index: 50;
    display: flex; align-items: flex-end; justify-content: center; background: rgba(0,0,0,.55);
  }
  .sheet-panel {
    width: 100%; max-width: 32rem; background: #18181b; border-radius: 28px 28px 0 0;
    padding: 16px; padding-bottom: max(1rem, calc(var(--sab) + 0.5rem));
  }
  .sheet-panel button { width: 100%; height: 44px; margin-top: 12px; border-radius: 999px; border: 0; background: #10b981; font-weight: 600; }

  .notif {
    position: fixed; inset-inline: 0; bottom: 0; z-index: 45;
    display: flex; justify-content: center; padding: 0 12px;
    padding-bottom: max(1rem, var(--sab)); pointer-events: none;
  }
  .notif-card {
    pointer-events: auto; width: 100%; max-width: 400px; background: #18181bcc;
    border: 1px solid #ffffff1a; border-radius: 28px; padding: 16px;
  }
  .notif-card button { margin-top: 10px; height: 40px; border-radius: 999px; border: 0; background: #10b981; width: 100%; font-weight: 600; }

  .call-bg { position: fixed; inset: 0; background: #0b1220; z-index: 5; }
  .call-ctl {
    position: fixed; inset-inline: 0; bottom: 0; z-index: 6;
    display: flex; justify-content: center; gap: 16px;
    padding: 16px; padding-bottom: max(1rem, var(--sab));
  }
  .call-ctl button { width: 56px; height: 56px; border-radius: 999px; border: 0; background: #ef4444; color: #fff; }

  #live-room-bar {
    position: fixed; inset-inline: 0; bottom: 0; z-index: 70;
    padding: 0 8px; padding-bottom: max(0.5rem, var(--sab));
    pointer-events: auto;
  }
  #live-room-bar .inner {
    max-width: 42rem; margin: 0 auto; display: flex; align-items: center; gap: 8px;
    border-radius: 16px; border: 1px solid #34d3994d; background: #09090bf2; padding: 8px;
    min-height: 56px;
  }
  #live-room-bar .icon { width: 36px; height: 36px; border-radius: 12px; background: #10b98126; flex-shrink: 0; }
  #live-room-bar .txt { flex: 1; min-width: 0; }
  #live-room-bar .txt b { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #live-room-bar .txt span { display: block; font-size: 12px; color: #a1a1aa; }
  #live-room-bar .btn { width: 40px; height: 40px; border-radius: 12px; border: 0; background: #27272a; color: #fff; flex-shrink: 0; }
`;

const bodyHtml = `
  <div id="stage"></div>
  <div id="live-room-bar" data-testid="live-room-bar">
    <div class="inner">
      <div class="icon"></div>
      <div class="txt"><b>Drop-in with Maya</b><span>Live audio continues</span></div>
      <button class="btn" type="button">☺</button>
      <button class="btn" type="button">✕</button>
    </div>
  </div>
`;

const SCREENS = {
  home: `<div class="app-shell" id="root">
    <div class="main">${"<div class='card'></div>".repeat(5)}<div class="card">Last</div></div>
    <div class="dock" data-ol-bottom-dock data-testid="home-dock"><button data-testid="start-room" type="button">Start a room</button></div>
  </div>`,
  dm: `<div class="screen-dm" data-ol-screen id="root">
    <div class="hdr">Maya</div>
    <div class="list">${"<div class='bubble'>Hey there</div>".repeat(8)}</div>
    <div class="composer" data-ol-bottom-pad data-testid="composer">
      <input data-testid="composer-input" placeholder="Message Maya…"/>
      <button data-testid="composer-send" type="button">➤</button>
    </div>
  </div>`,
  group: `<div class="screen-group" data-ol-screen id="root">
    <div class="hdr">New group</div>
    <div class="list"><div class="card"></div><div class="card"></div></div>
    <div class="group-footer" data-ol-bottom-pad data-testid="group-footer">
      <button data-testid="group-create" type="button">Create group</button>
    </div>
  </div>`,
  sheet: `<div class="app-shell" id="root"><div class="main"><div class="card"></div></div></div>
    <div class="sheet-overlay" data-ol-sheet data-testid="sheet">
      <div class="sheet-panel"><h2>Start a room</h2><p style="color:#a1a1aa">Pick a topic</p>
        <button data-testid="sheet-primary" type="button">Create</button>
      </div>
    </div>`,
  notif: `<div class="app-shell" id="root"><div class="main"><div class="card"></div></div>
    <div class="dock" data-ol-bottom-dock><button type="button">Start a room</button></div></div>
    <div class="notif" data-ol-notif data-testid="notif-prompt">
      <div class="notif-card"><b>Turn on notifications?</b>
        <button data-testid="notif-allow" type="button">Allow</button>
      </div>
    </div>`,
  call: `<div class="call-bg" id="root"></div>
    <div class="call-ctl" data-ol-bottom-dock data-testid="call-controls">
      <button data-testid="call-end" type="button">End</button>
    </div>`,
};

const TARGETS = {
  home: ["[data-testid=start-room]"],
  dm: ["[data-testid=composer-input]", "[data-testid=composer-send]"],
  group: ["[data-testid=group-create]"],
  sheet: ["[data-testid=sheet-primary]"],
  notif: ["[data-testid=notif-allow]"],
  call: ["[data-testid=call-end]"],
};

function overlaps(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}
function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return x * y;
}

const report = [];
const br = await pw.chromium.launch();
for (const [w, h] of SIZES) {
  const sab = SAB[w] ?? 0;
  const ctx = await br.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html lang="en" data-live-room-bar>
    <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
    <style>${cssFor(sab, MODE)}</style></head>
    <body>${bodyHtml}</body></html>`, { waitUntil: "load" });

  for (const name of Object.keys(SCREENS)) {
    await page.evaluate((html) => {
      document.getElementById("stage").innerHTML = html;
      const bar = document.getElementById("live-room-bar");
      const h = bar.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--ol-liveroom-bar-h", `${h}px`);
      document.documentElement.setAttribute("data-live-room-bar", "");
    }, SCREENS[name]);
    await page.waitForTimeout(30);

    const geom = await page.evaluate((sels) => {
      const bar = document.getElementById("live-room-bar").getBoundingClientRect();
      const targets = sels.map((sel) => {
        const el = document.querySelector(sel);
        const r = el ? el.getBoundingClientRect() : null;
        return { sel, r: r ? { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null };
      });
      return { bar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height, top: bar.top, bottom: bar.bottom, left: bar.left, right: bar.right }, targets };
    }, TARGETS[name]);

    const hits = [];
    for (const t of geom.targets) {
      if (!t.r || geom.bar.h <= 0) continue;
      const A = { left: t.r.left, top: t.r.top, right: t.r.right, bottom: t.r.bottom };
      const B = { left: geom.bar.left, top: geom.bar.top, right: geom.bar.right, bottom: geom.bar.bottom };
      if (overlaps(A, B)) {
        hits.push({ sel: t.sel, area: Math.round(overlapArea(A, B)), targetBottom: Math.round(A.bottom), barTop: Math.round(B.top) });
      }
    }
    const shot = `${OUT}/${name}-${w}x${h}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    report.push({ size: `${w}x${h}`, screen: name, overlaps: hits, barH: Math.round(geom.bar.h), shot });
    console.log(hits.length ? "OVERLAP" : "clear  ", `${MODE} ${name}@${w}`, hits.length ? JSON.stringify(hits) : `barH=${Math.round(geom.bar.h)}`);
  }
  await ctx.close();
}
await br.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const n = report.filter((r) => r.overlaps.length).length;
console.log(`\n${MODE.toUpperCase()}: ${n}/${report.length} screen×size combos have overlaps`);
process.exit(MODE === "after" && n > 0 ? 1 : 0);
