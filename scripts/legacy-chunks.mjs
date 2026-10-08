// Post-build: make every client chunk safe to *start* on old WebViews (Android 7+ stock WebView = Chrome 69+).
// Turbopack chunks open with `globalThis.TURBOPACK…` and Next's async <script>s can run before any inline <head>
// script, so the globalThis polyfill has to live in the chunks themselves. Idempotent; ~50 bytes per chunk.
// The other runtime polyfills are inlined first in <head> (src/lib/legacyPolyfills.ts): they're only needed once
// app code runs, after the parser has passed them.
import fs from "node:fs";
import path from "node:path";

const PREFIX = '"undefined"==typeof globalThis&&(self.globalThis=self);';
const dir = path.resolve(process.argv[2] || ".next/static/chunks");
let n = 0;
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) {
      const s = fs.readFileSync(p, "utf8");
      if (s.startsWith(PREFIX) || !s.includes("globalThis")) continue;
      fs.writeFileSync(p, PREFIX + s);
      n++;
    }
  }
};
if (fs.existsSync(dir)) walk(dir);
console.log(`[legacy-chunks] globalThis guard added to ${n} chunk(s)`);
