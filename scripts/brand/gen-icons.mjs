// Generates every app-icon asset from ONE master: the glyph + gradient of public/brand/mark.svg (1024 grid).
// Run: node scripts/brand/gen-icons.mjs [outDir=assets/app-icon]
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
const out = process.argv[2] || "assets/app-icon";
fs.mkdirSync(out, { recursive: true });
const GRAD = `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34D399"/><stop offset="1" stop-color="#059669"/></linearGradient>`;
const HL = `<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
// glyph: capsule, grille levels (optional), yoke + stand. scale s around centre (512,504)
const glyph = (fg, lvl, s = 1) => `<g transform="translate(512 512) scale(${s}) translate(-512 -504)">
<rect x="400" y="200" width="224" height="384" rx="112" fill="${fg}"/>
${lvl ? `<g fill="${lvl}"><rect x="456" y="296" width="112" height="24" rx="12"/><rect x="456" y="360" width="112" height="24" rx="12"/><rect x="456" y="424" width="112" height="24" rx="12"/></g>` : ""}
<path d="M304 480v16a208 208 0 0 0 416 0v-16M512 712v104M400 824h224" fill="none" stroke="${fg}" stroke-width="64" stroke-linecap="round"/></g>`;
const svg = (body, defs = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${GRAD}${HL}${defs}</defs>${body}</svg>`);
const full = (s = 0.78) => svg(`<rect width="1024" height="1024" fill="url(#g)"/><rect width="1024" height="1024" fill="url(#hl)"/>${glyph("#fff", "#10B981", s)}`);
const SQ = fs.readFileSync("public/brand/mark.svg", "utf8");
const png = (buf, size, file, opts = {}) => {
  let p = sharp(buf, { density: 300 }).resize(size, size);
  if (opts.flatten) p = p.flatten({ background: opts.flatten });
  return p.png().toFile(path.join(out, file));
};
const jobs = [
  // iOS (Expo "ios.icon"): 1024 opaque square, iOS applies the mask
  png(full(), 1024, "ios-1024.png", { flatten: "#059669" }),
  // iOS 18 dark: transparent bg, emerald glyph (system supplies dark backdrop)
  png(svg(glyph("#34D399", "#0b0f0e", 0.78)), 1024, "ios-1024-dark.png"),
  // iOS 18 tinted: grayscale glyph on transparent (system tints luminance)
  png(svg(glyph("#ffffff", "#8a8a8a", 0.78)), 1024, "ios-1024-tinted.png"),
  // Android adaptive layers (Expo adaptiveIcon), 432 = 108dp@xxxhdpi; glyph in the 66dp safe zone
  png(svg(glyph("#fff", "#10B981", 0.62)), 1024, "android-adaptive-foreground.png"),
  png(svg(`<rect width="1024" height="1024" fill="url(#g)"/>`), 1024, "android-adaptive-background.png", { flatten: "#059669" }),
  png(svg(glyph("#fff", null, 0.62)), 1024, "android-adaptive-monochrome.png"),
  png(full(), 512, "play-store-512.png", { flatten: "#059669" }),
  // web
  png(Buffer.from(SQ), 192, "pwa-192.png"),
  png(Buffer.from(SQ), 512, "pwa-512.png"),
  png(full(0.62), 512, "pwa-maskable-512.png", { flatten: "#059669" }),
  png(full(), 180, "apple-touch-icon-180.png", { flatten: "#059669" }),
  png(Buffer.from(SQ.replace(/<g fill="#10B981"[^]*?<\/g>/, "")), 32, "favicon-32.png"),
  png(Buffer.from(SQ.replace(/<g fill="#10B981"[^]*?<\/g>/, "")), 16, "favicon-16.png"),
];
await Promise.all(jobs);
fs.copyFileSync("public/brand/mark.svg", path.join(out, "master.svg"));
console.log("icons →", out, fs.readdirSync(out).join(", "));
