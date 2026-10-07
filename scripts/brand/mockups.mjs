// Contact sheet + home-screen mockups for the app-icon set (preview only).
import sharp from "sharp";
const A = "assets/app-icon/", O = process.argv[2] || "/workspace/integration-screens/logo/final-";
const mask = (s, r) => Buffer.from(`<svg width="${s}" height="${s}"><rect width="${s}" height="${s}" rx="${r}" fill="#fff"/></svg>`);
const circle = (s) => Buffer.from(`<svg width="${s}" height="${s}"><circle cx="${s/2}" cy="${s/2}" r="${s/2}" fill="#fff"/></svg>`);
async function masked(file, s, m, bg) {
  let img = sharp(A + file).resize(s, s);
  if (bg) img = sharp({ create: { width: s, height: s, channels: 4, background: bg } }).composite([{ input: await img.png().toBuffer() }]);
  return sharp(await img.png().toBuffer()).composite([{ input: m, blend: "dest-in" }]).png().toBuffer();
}
const txt = (w, t, c) => Buffer.from(`<svg width="${w}" height="30"><text x="${w/2}" y="20" font-family="sans-serif" font-size="18" fill="${c}" text-anchor="middle">${t}</text></svg>`);
async function screen(name, wall, label, icon) {
  const W = 540, H = 960, S = 120, comps = [];
  const fillers = ["#f43f5e", "#3b82f6", "#f59e0b", "#8b5cf6", "#06b6d4", "#64748b", "#ec4899"];
  let k = 0;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
    const x = 24 + c * 128, y = 140 + r * 170;
    const ic = r === 0 && c === 1 ? icon : await sharp({ create: { width: S - 20, height: S - 20, channels: 4, background: fillers[k++ % 7] } }).composite([{ input: label.includes("Android") ? circle(S - 20) : mask(S - 20, 24), blend: "dest-in" }]).png().toBuffer();
    comps.push({ input: ic, left: x + (r === 0 && c === 1 ? 0 : 10), top: y + (r === 0 && c === 1 ? 0 : 10) });
    comps.push({ input: txt(128, r === 0 && c === 1 ? "Open Lounge" : "App", wall.text), left: x - 4, top: y + S + 4 });
  }
  comps.push({ input: Buffer.from(`<svg width="${W}" height="40"><text x="20" y="28" font-family="sans-serif" font-size="20" fill="${wall.text}">${label}</text></svg>`), left: 0, top: 40 });
  await sharp({ create: { width: W, height: H, channels: 4, background: wall.bg } }).composite(comps).png().toFile(O + name);
}
const S = 120;
const ios = await masked("ios-1024.png", S, mask(S, 27));
const iosDark = await masked("ios-1024-dark.png", S, mask(S, 27), "#1c1c1e");
const iosTint = await sharp(await masked("ios-1024-tinted.png", S, mask(S, 27), "#1c1c1e")).tint("#7dd3fc").png().toBuffer();
const andr = async (fg, bg) => { const b = await sharp(A + bg).resize(S, S).png().toBuffer(); const f = await sharp(A + fg).resize(S, S).png().toBuffer(); return sharp(b).composite([{ input: f }, { input: circle(S), blend: "dest-in" }]).png().toBuffer(); };
const and = await andr("android-adaptive-foreground.png", "android-adaptive-background.png");
const mono = await sharp(await sharp({ create: { width: S, height: S, channels: 4, background: "#d9e7dc" } }).composite([{ input: await sharp(A + "android-adaptive-monochrome.png").resize(S, S).tint("#1f3a2c").png().toBuffer() }, { input: circle(S), blend: "dest-in" }]).png().toBuffer()).png().toBuffer();
await screen("icon-home-ios-light.png", { bg: "#c7d7f0", text: "#111" }, "iOS — default", ios);
await screen("icon-home-ios-dark.png", { bg: "#111827", text: "#eee" }, "iOS 18 — dark", iosDark);
await screen("icon-home-ios-tinted.png", { bg: "#0b1320", text: "#eee" }, "iOS 18 — tinted", iosTint);
await screen("icon-home-android.png", { bg: "#efe7da", text: "#111" }, "Android — adaptive", and);
await screen("icon-home-android-themed.png", { bg: "#1e2a24", text: "#eee" }, "Android 13 — themed (monochrome)", mono);
const files = ["icon-home-ios-light.png", "icon-home-ios-dark.png", "icon-home-ios-tinted.png", "icon-home-android.png", "icon-home-android-themed.png"];
await sharp({ create: { width: 540 * 5, height: 960, channels: 4, background: "#fff" } }).composite(files.map((f, i) => ({ input: O + f, left: i * 540, top: 0 }))).png().toFile(O + "icon-final-mockups-sheet.png");
console.log("mockups →", O);
