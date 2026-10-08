// Post-build for old WebViews (Android 7+ stock WebView = Chrome 69+), run by `npm run build`.
// 1) JS: Turbopack chunks open with `globalThis.TURBOPACK…` and Next's async <script>s can run before any inline
//    <head> script, so a globalThis shim is prepended to each client chunk (~50 bytes). Syntax itself is lowered by
//    the browserslist in package.json; other runtime polyfills are inlined first in <head> (src/lib/legacyPolyfills.ts).
// 2) CSS: Tailwind v4 output relies on @layer (Chrome 99+), nesting, oklch()/color-mix(). Old engines drop whole
//    @layer blocks, so the app renders unstyled. postcss-preset-env lowers the final bundled CSS (layers emulated
//    by specificity, nesting flattened, color fallbacks). Modern browsers render pixel-identically (checked in
//    Chromium + WebKit); gzip cost ≈ +2 KB.
// 3) flex `gap` fallback for Chrome < 84, see below.
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

// 3) Flexbox `gap` only exists from Chrome 84 (grid gap is older, so @supports can't tell them apart). The inline
//    head script (src/lib/legacyPolyfills.ts) measures it and sets <html data-noflexgap> on engines without it;
//    only then do these margin rules apply, so modern browsers are untouched. For every rule that sets gap/row-gap/
//    column-gap we emit, under the same @media, `[data-noflexgap] <sel> > * + *` margins in the main direction
//    (margin-top for column flex, margin-right/bottom for wrapping rows). Grids, absolutely positioned children
//    and children that set their own margin on that side (ml-auto, mx-auto, mt-2, …) are left alone. Text runs are
//    flex items too but CSS can't select them, so on those engines the head script tags elements that sit next to
//    a text run (data-gn: text follows, data-gp: text precedes) and these rules space them as well.
const OWN = (sides) => sides.flatMap((m) => [`[class*="${m}-"]`]).map((a) => `:not(${a})`).join("");
const NOT_H = ':not(.absolute):not(.fixed):not(.hidden)' + OWN(["ml", "mx", "-m"]) + ':not([class^="m-"]):not([class*=" m-"]):not([class*=":m-"]):not([class^="ms-"]):not([class*=" ms-"]):not([class*=":ms-"])';
const NOT_V = ':not(.absolute):not(.fixed):not(.hidden)' + OWN(["mt", "my", "-m"]) + ':not([class^="m-"]):not([class*=" m-"]):not([class*=":m-"])';
function splitGap(v) {
  let depth = 0, cut = -1;
  for (let i = 0; i < v.length; i++) { const c = v[i]; if (c === "(") depth++; else if (c === ")") depth--; else if (c === " " && depth === 0) { cut = i; break; } }
  return cut < 0 ? [v, v] : [v.slice(0, cut).trim(), v.slice(cut + 1).trim()];
}
// 4) :where() is Chrome 88+ / Safari 14+; Tailwind v4 wraps space-x/y, divide-* and group-* selectors in it, so older
//    engines drop those rules (no stack spacing, no overlapping avatar rows). The head script sets <html data-nowhere>
//    there, and each :where() rule gets a twin right after it (same layer) with :where(…) unwrapped, under that flag.
function unwrapWhere(sel) {
  let out = "", i = 0;
  while (i < sel.length) {
    const j = sel.indexOf(":where(", i);
    if (j < 0) { out += sel.slice(i); break; }
    out += sel.slice(i, j);
    let depth = 1, k = j + 7, comma = false;
    for (; k < sel.length && depth; k++) { const c = sel[k]; if (c === "(") depth++; else if (c === ")") depth--; else if (c === "," && depth === 1) comma = true; }
    if (comma) return null;
    out += sel.slice(j + 7, k - 1);
    i = k;
  }
  return out;
}
function flexGapFallback(postcss) {
  return {
    postcssPlugin: "ol-flex-gap-fallback",
    OnceExit(root) {
      const out = [];
      let whereTwins = 0;
      root.walkRules((rule) => {
        if (rule.selector?.includes(":where(") && !rule.parent?.name?.endsWith("keyframes")) {
          const twins = rule.selectors.map(unwrapWhere);
          if (twins.every(Boolean)) {
            rule.after(rule.clone({ selectors: twins.map((t) => `[data-nowhere] ${t}`) }));
            whereTwins++;
          }
        }
        if (!rule.selector || rule.parent?.type === "rule") return;
        let row = null, col = null, display = "", dir = "", wrap = "";
        rule.each((d) => {
          if (d.type !== "decl") return;
          if (d.prop === "gap") [row, col] = splitGap(d.value);
          else if (d.prop === "row-gap") row = d.value;
          else if (d.prop === "column-gap") col = d.value;
          else if (d.prop === "display") display = d.value;
          else if (d.prop === "flex-direction") dir = d.value;
          else if (d.prop === "flex-wrap") wrap = d.value;
          else if (d.prop === "flex-flow") { dir = d.value; wrap = d.value; }
        });
        if ((row == null && col == null) || /grid/.test(display)) return;
        const imp = (v) => v && !/^(0|0px|normal)$/.test(v) ? v.replace(/\s*!important$/, "") : null;
        row = imp(row); col = imp(col);
        if (!row && !col) return;
        const wraps = [];
        for (let a = rule.parent; a && a.type === "atrule"; a = a.parent) if (/^(media|supports)$/i.test(a.name)) wraps.unshift(a);
        const rules = [];
        const add = (sel, decls) => rules.push(postcss.rule({ selector: sel }).append(...decls.map((d) => postcss.decl(d))));
        for (const raw of rule.selectors) {
          const s = `[data-noflexgap] ${raw}:not(.grid):not(.inline-grid)`;
          const colDir = /column/.test(dir), rowWrap = /wrap/.test(wrap) && !/nowrap/.test(wrap);
          if (colDir) { if (row) add(`${s}>*+*${NOT_V},${s}>[data-gp]${NOT_V}`, [{ prop: "margin-top", value: row }]); continue; }
          if (rowWrap) {
            if (col) add(`${s}>*${NOT_H}`, [{ prop: "margin-right", value: col }]);
            if (row) add(`${s}>*${NOT_V}`, [{ prop: "margin-bottom", value: row }]);
            continue;
          }
          if (col) add(`${s}:not(.flex-col):not(.flex-col-reverse):not(.flex-wrap)>*+*${NOT_H},${s}:not(.flex-col):not(.flex-col-reverse):not(.flex-wrap)>[data-gp]${NOT_H}`, [{ prop: "margin-left", value: col }]);
          if (col) add(`${s}:not(.flex-col):not(.flex-col-reverse):not(.flex-wrap)>[data-gn]${NOT_H.replace(/ml-/g, "mr-").replace(/ms-/g, "me-")}`, [{ prop: "margin-right", value: col }]);
          if (row) add(`${s}.flex-col>*+*${NOT_V},${s}.flex-col-reverse>*+*${NOT_V}`, [{ prop: "margin-top", value: row }]);
          if (col) add(`${s}.flex-wrap:not(.flex-col)>*${NOT_H}`, [{ prop: "margin-right", value: col }]);
          if (row) add(`${s}.flex-wrap:not(.flex-col)>*${NOT_V}`, [{ prop: "margin-bottom", value: row }]);
        }
        let node = rules;
        for (let i = wraps.length - 1; i >= 0; i--) node = [postcss.atRule({ name: wraps[i].name, params: wraps[i].params }).append(...node)];
        out.push(...node);
      });
      if (out.length) root.append(...out);
      root.__olGapRules = out.length;
      root.__olWhere = whereTwins;
    },
  };
}
flexGapFallback.postcss = true;

try {
  const { default: postcss } = await import("postcss");
  const { default: presetEnv } = await import("postcss-preset-env");
  const flatten = postcss([presetEnv({ browsers: pkg.browserslist, stage: false, features: { "nesting-rules": true } })]);
  const gaps = postcss([flexGapFallback(postcss)]);
  const run = postcss([presetEnv({ browsers: pkg.browserslist, stage: 2, features: { "cascade-layers": true, "nesting-rules": true, "custom-properties": false } })]);
  let css = 0, before = 0, after = 0, gapRules = 0, whereRules = 0;
  for (const p of files.filter((f) => f.endsWith(".css"))) {
    const s = fs.readFileSync(p, "utf8");
    if (s.startsWith(CSS_MARK)) continue;
    const flat = (await flatten.process(s, { from: p, to: p, map: false })).root;
    const g = await gaps.process(flat, { from: p, to: p, map: false });
    gapRules += g.root.__olGapRules || 0;
    whereRules += g.root.__olWhere || 0;
    const out = await run.process(g.root, { from: p, to: p, map: false });
    fs.writeFileSync(p, CSS_MARK + out.css);
    css++; before += s.length; after += out.css.length;
  }
  console.log(`[legacy] CSS lowered in ${css} file(s): ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (${gapRules} flex-gap fallbacks, ${whereRules} :where twins)`);
} catch (e) {
  console.warn(`[legacy] CSS lowering skipped: ${e.message}`); if (process.env.LEGACY_DEBUG) console.warn(e.stack);
}
