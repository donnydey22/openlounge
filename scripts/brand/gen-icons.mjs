// Generates the master mark and every app-icon asset from ONE source: the header mic (scripts/brand/mic.mjs).
// Run: node scripts/brand/gen-icons.mjs            → writes a STAGING copy only (default /workspace/integration-screens/logo/icon-staging)
//      APPLY=1 node scripts/brand/gen-icons.mjs    → writes into the repo (public/brand, public/icons, assets/app-icon, android mipmaps)
// APPLY also needs mipmap-anydpi-v26/ic_launcher*.xml to point foreground/monochrome at @mipmap/ (bitmap layers).
// Mic art is swappable: MIC_SRC=path/to/128x128.svg (see scripts/brand/mic.mjs). Icon art is ON HOLD pending Donny's reference.
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { placed as rawPlaced } from "./mic.mjs";
const placed = (pal, sc) => (pal === "color" ? `<g filter="url(#sh)">${rawPlaced(pal, sc)}</g>` : rawPlaced(pal, sc));
const ROOT = process.env.APPLY ? "." : process.env.STAGING || "/workspace/integration-screens/logo/icon-staging";
const R = (p) => path.join(ROOT, p);
const out = R("assets/app-icon");
for (const d of ["public/brand", "public/icons"]) fs.mkdirSync(R(d), { recursive: true });
fs.mkdirSync(out, { recursive: true });
const SQ = "M1024 512L1024 684L1022 739L1020 778L1017 810L1013 837L1008 861L1002 881L995 900L988 917L979 932L969 945L958 958L945 969L932 979L917 988L900 995L881 1002L861 1008L837 1013L810 1017L778 1020L739 1022L684 1024L512 1024L340 1024L285 1022L246 1020L214 1017L187 1013L163 1008L143 1002L124 995L107 988L92 979L79 969L66 958L55 945L45 932L36 917L29 900L22 881L16 861L11 837L7 810L4 778L2 739L0 684L0 512L0 340L2 285L4 246L7 214L11 187L16 163L22 143L29 124L36 107L45 92L55 79L66 66L79 55L92 45L107 36L124 29L143 22L163 16L187 11L214 7L246 4L285 2L340 0L512 0L684 0L739 2L778 4L810 7L837 11L861 16L881 22L900 29L917 36L932 45L945 55L958 66L969 79L979 92L988 107L995 124L1002 143L1008 163L1013 187L1017 214L1020 246L1022 285L1024 340Z";
// Background variants (BG_VARIANT): A diagonal, B radial core, C diagonal + radial highlight (default)
const V = process.env.BG_VARIANT || "C";
const DEFS = `<linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34D399"/><stop offset=".55" stop-color="#10B981"/><stop offset="1" stop-color="#047857"/></linearGradient>
<radialGradient id="r" cx=".5" cy=".46" r=".62"><stop offset="0" stop-color="#6EE7B7" stop-opacity="${V === "B" ? ".75" : ".45"}"/><stop offset=".6" stop-color="#6EE7B7" stop-opacity="0"/></radialGradient>
<radialGradient id="v" cx=".5" cy=".5" r=".75"><stop offset=".7" stop-color="#022C22" stop-opacity="0"/><stop offset="1" stop-color="#022C22" stop-opacity=".22"/></radialGradient>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34D399"/><stop offset="1" stop-color="#059669"/></linearGradient>
<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#022C22" flood-opacity=".35"/></filter>`;
const FILL = V === "B" ? `<rect width="1024" height="1024" fill="#10B981"/><rect width="1024" height="1024" fill="url(#r)"/><rect width="1024" height="1024" fill="url(#v)"/>`
  : V === "A" ? `<rect width="1024" height="1024" fill="url(#d)"/>`
  : `<rect width="1024" height="1024" fill="url(#d)"/><rect width="1024" height="1024" fill="url(#r)"/>`;
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${DEFS}</defs>${body}</svg>`);
const BG = FILL;
const SCALE = { full: 6.2, safe: 4.6 }; // full-bleed icon vs Android 66/108 safe zone & maskable
const mono = (s, color = "#fff") => `<mask id="m"><rect width="1024" height="1024" fill="#000"/>${placed("mask", s)}</mask><rect width="1024" height="1024" fill="${color}" mask="url(#m)"/>`;
// master (squircle badge) — used by the web LogoMark/favicon too
const master = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${DEFS}</defs><clipPath id="c"><path d="${SQ}"/></clipPath><g clip-path="url(#c)">${FILL}</g>${placed("color", SCALE.full)}</svg>`;
fs.writeFileSync(R("public/brand/mark.svg"), master);
fs.copyFileSync(R("public/brand/mark.svg"), path.join(out, "master.svg"));
const png = (buf, size, file, flatten) => { let p = sharp(buf, { density: 300 }).resize(size, size); if (flatten) p = p.flatten({ background: flatten }); return p.png().toFile(file.includes("/") ? R(file) : path.join(out, file)); };
const full = svg(BG + placed("color", SCALE.full));
const safeFull = svg(BG + placed("color", SCALE.safe));
const fg = svg(placed("color", SCALE.safe));
const mono66 = svg(mono(SCALE.safe));
const jobs = [
  png(full, 1024, "ios-1024.png", "#059669"),
  png(svg(placed("onDark", SCALE.full)), 1024, "ios-1024-dark.png"),
  png(svg(mono(SCALE.full, "#fff")), 1024, "ios-1024-tinted.png"),
  png(fg, 1024, "android-adaptive-foreground.png"),
  png(svg(BG), 1024, "android-adaptive-background.png", "#059669"),
  png(mono66, 1024, "android-adaptive-monochrome.png"),
  png(full, 512, "play-store-512.png", "#059669"),
  png(Buffer.from(master), 192, "pwa-192.png"),
  png(Buffer.from(master), 512, "pwa-512.png"),
  png(safeFull, 512, "pwa-maskable-512.png", "#059669"),
  png(full, 180, "apple-touch-icon-180.png", "#059669"),
  png(Buffer.from(master), 32, "favicon-32.png"),
  png(Buffer.from(master), 16, "favicon-16.png"),
  // web app (public/) copies
  png(Buffer.from(master), 192, "public/icons/icon-192.png"),
  png(Buffer.from(master), 512, "public/icons/icon-512.png"),
  png(safeFull, 512, "public/icons/maskable-512.png", "#059669"),
];
// Android mipmaps: adaptive layers (108dp) + legacy square/round (48dp)
const D = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const circle = (s) => Buffer.from(`<svg width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}"/></svg>`);
const rr = (s) => Buffer.from(`<svg width="${s}" height="${s}"><rect width="${s}" height="${s}" rx="${s * 0.2}"/></svg>`);
for (const [d, k] of Object.entries(D)) {
  const dir = `android/app/src/main/res/mipmap-${d}`;
  fs.mkdirSync(R(dir), { recursive: true });
  jobs.push(png(fg, 108 * k, `${dir}/ic_launcher_foreground.png`));
  jobs.push(png(svg(BG), 108 * k, `${dir}/ic_launcher_background.png`, "#059669"));
  jobs.push(png(mono66, 108 * k, `${dir}/ic_launcher_monochrome.png`));
  const s = 48 * k;
  const base = sharp(safeFull, { density: 300 }).resize(s, s).png().toBuffer();
  jobs.push(base.then((b) => sharp(b).composite([{ input: rr(s), blend: "dest-in" }]).png().toFile(R(`${dir}/ic_launcher.png`))));
  jobs.push(base.then((b) => sharp(b).composite([{ input: circle(s), blend: "dest-in" }]).png().toFile(R(`${dir}/ic_launcher_round.png`))));
}
await Promise.all(jobs);
console.log("icons generated →", ROOT);
