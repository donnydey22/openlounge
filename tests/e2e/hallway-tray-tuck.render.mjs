// Tucked edge tab + open tray never cover app UI at 375/412/820/1280. Run: node tests/e2e/hallway-tray-tuck.render.mjs
import pw from "playwright";
const SIZES = [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const html = (tucked) => `<!doctype html><html data-live-room-bar><head><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:#000}
html[data-live-room-bar] [data-ol-screen]{padding-bottom:var(--ol-liveroom-bar-h)}
html[data-live-room-bar] [data-ol-bottom-dock]{bottom:var(--ol-liveroom-bar-h)!important}
.screen{position:fixed;inset:0;display:flex;flex-direction:column}.screen .body{flex:1}
.composer{height:56px;background:#222}.send{position:absolute;right:8px;width:40px;height:40px}
.dock{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:flex-end;padding:0 8px}
.dock button{height:48px;width:160px}
#bar{position:fixed;left:0;right:0;bottom:0;padding:0 8px 8px}
#bar .wrap{max-width:672px;margin:0 auto;display:flex;justify-content:flex-end}
#tab{height:32px;width:72px;border-radius:999px}#open{height:56px;width:100%}
</style></head><body>
<div class="screen" data-ol-screen><div class="body"></div><div class="composer" data-ui><button class="send" data-ui>›</button></div></div>
<div class="dock" data-ol-bottom-dock><button data-ui>Start a room</button></div>
<div id="bar"><div class="wrap">${tucked ? '<button id="tab">Live</button>' : '<div id="open"></div>'}</div></div>
<script>const b=document.getElementById('bar');document.documentElement.style.setProperty('--ol-liveroom-bar-h',Math.ceil(b.getBoundingClientRect().height)+'px')</script>
</body></html>`;
const browser = await pw.chromium.launch();
let fail = 0;
for (const [w, h] of SIZES) for (const tucked of [true, false]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(html(tucked));
  const bad = await page.evaluate(() => {
    const t = document.getElementById("bar").firstElementChild.firstElementChild.getBoundingClientRect();
    return [...document.querySelectorAll("[data-ui]")].filter((e) => { const r = e.getBoundingClientRect();
      return r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top; }).length;
  });
  console.log(`${w}x${h} ${tucked ? "tucked" : "open"}: ${bad ? "OVERLAP" : "ok"}`);
  fail += bad; await page.close();
}
await browser.close();
if (fail) { console.error("FAIL"); process.exit(1); } console.log("PASS");
