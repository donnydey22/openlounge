// Post-build for old WebViews (Android 7+ stock WebView = Chrome 69+), run by `npm run build`.
// 1) JS: Turbopack chunks open with `globalThis.TURBOPACK…` and Next's async <script>s can run before any inline
//    <head> script, so a globalThis shim is prepended to each client chunk (~50 bytes). Syntax itself is lowered by
//    the browserslist in package.json; other runtime polyfills are inlined first in <head> (src/lib/legacyPolyfills.ts).
// 2) CSS: Tailwind v4 output relies on @layer (Chrome 99+), nesting, oklch()/color-mix(). Old engines drop whole
//    @layer blocks, so the app renders unstyled. postcss-preset-env lowers the final bundled CSS (layers emulated
//    by specificity, nesting flattened, color fallbacks). Modern browsers render pixel-identically (checked in
//    Chromium + WebKit); gzip cost ≈ +2 KB.
// Idempotent (marker comment / prefix), never fails the build: on error it logs and leaves files as they were.
import fs from "node:fs";
import path from "node:path";

const PREFIX = '"undefined"==typeof globalThis&&(self.globalThis=self);';
const CSS_MARK = "/*ol-legacy*/";
const dir = path.resolve(process.argv[2] || ".next/static/chunks");
const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css)$/.test(p)) files.push(p);
  }
};
if (fs.existsSync(dir)) walk(dir);

let js = 0;
for (const p of files.filter((f) => f.endsWith(".js"))) {
  const s = fs.readFileSync(p, "utf8");
  if (s.startsWith(PREFIX) || !s.includes("globalThis")) continue;
  fs.writeFileSync(p, PREFIX + s);
  js++;
}
console.log(`[legacy] globalThis guard added to ${js} chunk(s)`);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
try {
  const { default: postcss } = await import("postcss");
  const { default: presetEnv } = await import("postcss-preset-env");
  const run = postcss([presetEnv({ browsers: pkg.browserslist, stage: 2, features: { "cascade-layers": true, "nesting-rules": true, "custom-properties": false } })]);
  let css = 0, before = 0, after = 0;
  for (const p of files.filter((f) => f.endsWith(".css"))) {
    const s = fs.readFileSync(p, "utf8");
    if (s.startsWith(CSS_MARK)) continue;
    const out = await run.process(s, { from: p, to: p, map: false });
    fs.writeFileSync(p, CSS_MARK + out.css);
    css++; before += s.length; after += out.css.length;
  }
  console.log(`[legacy] CSS lowered in ${css} file(s): ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
} catch (e) {
  console.warn(`[legacy] CSS lowering skipped: ${e.message}`);
}
