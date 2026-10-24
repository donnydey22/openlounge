// FX-052/FX-053 render: composer cap + internal scroll, jump-to-latest appear/hide/badge/scroll.
// Server must run with CSP=0 locally (production CSP has upgrade-insecure-requests, which WebKit applies to http://127.0.0.1).
// BASE=http://127.0.0.1:3360 ENGS=chromium,webkit,firefox node --import tsx tests/e2e/composer-cap-jump.render.mts
import pw from "playwright";
import { phoneLogin } from "../unified-auth/harness";
const BASE = process.env.BASE || "http://127.0.0.1:3350", WS = BASE.replace(/^http/, "ws") + "/ws";
const OUT = process.env.SHOTS || "";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`; const r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
const DEVICES: [string, number, number, boolean][] = [["iphone-se", 375, 667, true], ["iphone-15-pro-max", 430, 932, true], ["pixel-7", 412, 915, true], ["android-small", 360, 640, true], ["ipad", 820, 1180, true], ["desktop", 1280, 800, false]];
const ENGS = (process.env.ENGS || "chromium,webkit,firefox").split(",") as ("chromium" | "webkit" | "firefox")[];
const THEMES = (process.env.THEMES || "dark,light").split(",");
const DEV = process.env.DEVICES ? DEVICES.filter((d) => process.env.DEVICES!.split(",").includes(d[0])) : DEVICES;
for (const eng of ENGS) {
  const br = await pw[eng].launch();
  // the bundled test engines are older than the production browser floor; tag as the app wrapper (the WebView path) to pass it
  const uaCtx = await br.newContext(); const baseUA = await (await uaCtx.newPage()).evaluate(() => navigator.userAgent); await uaCtx.close();
  for (const [name, w, h, mobile] of DEV) for (const theme of THEMES) {
    const t = `${eng} ${name} ${theme}`;
    const a = await phoneLogin(WS, ph(), { firstName: "Donny", username: "donny_" + r() });
    const b = await phoneLogin(WS, ph(), { firstName: "Keiko", username: "keiko_" + r() });
    // server rate limit is 8 msgs / 10 s, so seed 7 tall messages (several screens of history)
    for (let i = 1; i <= 7; i++) await b.client.req("dm:send", { to: a.res.user.id, text: `Message ${i} ${"🙂".repeat(i % 3)}\n` + Array.from({ length: 14 }, (_, j) => `line ${j + 1} — the quick brown fox`).join("\n") });
    const seededAt = Date.now();
    const U = { refresh: a.res.refresh ?? a.res.token, access: a.res.access, uid: a.res.user.id, theme };
    const ctx = await br.newContext({ userAgent: baseUA + ' OpenLounge/test', viewport: { width: w, height: h }, ...(mobile && eng !== "firefox" ? { hasTouch: true, isMobile: eng === "chromium" } : {}), ...(OUT ? { recordVideo: { dir: `${OUT}/video`, size: { width: Math.min(w, 640), height: Math.min(h, 960) } } } : {}) });
    await ctx.addInitScript((u: any) => { localStorage.setItem("openlounge:theme", u.theme); if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U);
    const page = await ctx.newPage(); const errs: string[] = []; page.on("pageerror", (e) => errs.push(e.message));
    const shot = (s: string) => OUT ? page.screenshot({ path: `${OUT}/${eng}-${name}-${theme}-${s}.png` }) : Promise.resolve();
    try {
      await page.goto(`${BASE}/messages/${b.res.user.id}`); await sleep(2500);
      const nn = page.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click();
      const ta = page.locator("[data-testid=composer-input]:visible").first(); await ta.waitFor();
      const list = page.locator("[data-testid=dm-list]");
      const jump = page.locator("[data-testid=jump-latest]");
      const shown = async () => (await jump.getAttribute("data-show")) === "1";
      check(`${t}: jump hidden at bottom on open`, !(await shown()));
      // ---- composer cap
      await ta.click(); const h1 = (await ta.boundingBox())!.height;
      const sendBox0 = await page.getByRole("button", { name: "Send message" }).first().boundingBox().catch(() => null);
      const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long pasted note`).join("\n");
      await ta.fill(long); await ta.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await sleep(250);
      const m = await ta.evaluate((el: HTMLTextAreaElement) => { const cs = getComputedStyle(el); return { h: el.getBoundingClientRect().height, sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop, oy: cs.overflowY, lh: parseFloat(cs.lineHeight), vh: window.visualViewport?.height || innerHeight }; });
      check(`${t}: composer capped ≤ 6 lines + padding`, m.h <= m.lh * 6 + 30, JSON.stringify(m));
      check(`${t}: composer ≤ 40% viewport`, m.h <= m.vh * 0.4 + 1, `${m.h}/${m.vh}`);
      check(`${t}: scrolls internally once capped`, m.sh > m.ch + 10 && m.oy === "auto", JSON.stringify(m));
      check(`${t}: caret (end) kept visible`, m.st + m.ch >= m.sh - 4, JSON.stringify(m));
      const sendBox = await page.getByRole("button", { name: "Send message" }).first().boundingBox().catch(() => null);
      const taBox = (await ta.boundingBox())!;
      if (sendBox) check(`${t}: send button bottom-aligned`, Math.abs(sendBox.y + sendBox.height - (taBox.y + taBox.height)) <= 8, `${sendBox.y + sendBox.height} vs ${taBox.y + taBox.height}`);
      const lb = (await list.boundingBox())!; check(`${t}: list still visible above composer`, lb.height > 120, String(lb.height));
      const nearBottom = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80);
      check(`${t}: list stays anchored to newest while composer grows`, nearBottom);
      await shot("1-composer-capped");
      // keyboard simulation: viewport shrinks ~45% → cap re-fits to 40% of what's left
      if (mobile) {
        await page.setViewportSize({ width: w, height: Math.round(h * 0.55) }); await sleep(400);
        const k = await ta.evaluate((el) => ({ h: el.getBoundingClientRect().height, vh: window.visualViewport?.height || innerHeight }));
        check(`${t}: [keyboard] cap re-fits to 40% of visible viewport`, k.h <= k.vh * 0.4 + 1, JSON.stringify(k));
        await shot("2-keyboard-up");
        await page.setViewportSize({ width: w, height: h }); await sleep(300);
      }
      // send → shrinks back
      await page.getByRole("button", { name: "Send message" }).first().click(); await sleep(1200);
      const h3 = (await ta.boundingBox())!.height;
      check(`${t}: shrinks back after send`, (await ta.inputValue()) === "" && h3 <= h1 + 2, `${h1}→${h3}`);
      // delete shrinks too
      await ta.fill("a\nb\nc\nd\ne"); await ta.evaluate((el) => el.dispatchEvent(new Event("input", { bubbles: true })));
      await ta.fill(""); await ta.evaluate((el) => el.dispatchEvent(new Event("input", { bubbles: true }))); await sleep(150);
      check(`${t}: shrinks back on delete`, (await ta.boundingBox())!.height <= h1 + 2);
      // ---- jump to latest
      await ta.blur();
      await list.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); }); await sleep(600);
      const ch = await list.evaluate((el) => ({ d: el.scrollHeight - el.scrollTop - el.clientHeight, c: el.clientHeight }));
      check(`${t}: jump appears > 1 screen up`, ch.d > ch.c && (await shown()), JSON.stringify(ch));
      const jb = await jump.boundingBox(); const cb = (await page.locator("[data-testid=composer]:visible").first().boundingBox())!;
      check(`${t}: jump ≥44px + sits above composer`, !!jb && jb.width >= 44 && jb.height >= 44 && jb.y + jb.height <= cb.y, JSON.stringify(jb));
      check(`${t}: jump has aria-label`, /Jump to latest/.test((await jump.getAttribute("aria-label")) || ""));
      await sleep(Math.max(0, 10_500 - (Date.now() - seededAt)));
      console.log("INFO", `${t}: distance ${ch.d}px vs screen ${ch.c}px →`, ch.d > ch.c * 3 ? "far path (instant + glide)" : "smooth path");
      for (let i = 1; i <= 3; i++) await b.client.req("dm:send", { to: a.res.user.id, text: `New while scrolled up ${i}` });
      await sleep(1500);
      const badge = await page.locator("[data-testid=jump-latest-badge]").innerText().catch(() => "");
      check(`${t}: unread badge counts new messages`, badge === "3", JSON.stringify(badge));
      await shot("3-jump-badge");
      await jump.click(); await sleep(1500);
      const dEnd = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      check(`${t}: tap scrolls to newest`, dEnd < 80, String(dEnd));
      check(`${t}: jump hides at bottom`, !(await shown()));
      check(`${t}: newest message visible`, await page.getByText("New while scrolled up 3").isVisible());
      await shot("4-at-latest");
      // RTL: button mirrors to the left
      await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
      await list.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); }); await sleep(500);
      const rb = await jump.boundingBox(); check(`${t}: RTL button on the left`, !!rb && rb.x < w / 2, JSON.stringify(rb));
      await page.evaluate(() => document.documentElement.setAttribute("dir", "ltr"));
      check(`${t}: no page errors`, errs.length === 0, errs.join("|").slice(0, 200));
    } catch (e) { check(`${t}: flow`, false, String(e).slice(0, 300)); if (OUT) await page.screenshot({ path: `${OUT}/${eng}-${name}-${theme}-FAIL.png` }).catch(() => {}); }
    await ctx.close(); a.client.close(); b.client.close();
  }
  await br.close();
}
console.log("pass", pass, "fail", fail); process.exit(fail ? 1 : 0);
