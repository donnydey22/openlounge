// Shared: Noto Color Emoji 🎙️ (U+1F399, Apache-2.0, assets/brand-src) on a 128 grid.
// SWAPPABLE: MIC_SRC env (any 128x128 SVG, repo-relative) replaces the mic layer; emitted as <g id="mic-art">.
import fs from "node:fs";
export const MIC_SRC = process.env.MIC_SRC || "assets/brand-src/noto-emoji_u1f399.svg";
const raw = fs.readFileSync(new URL("../../" + MIC_SRC, import.meta.url), "utf8");
const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<!--[\s\S]*?-->/g, "");
// "color" = Noto's own silver colours (unchanged). "mask" = single-colour silhouette (white = ink; the black switch stays cut out).
export const PALETTES = { color: {}, onDark: {}, mask: "white" };
export const mic = (pal) => (PALETTES[pal] === "white" ? inner.replace(/fill:(#[0-9A-Fa-f]{6})/g, (_, c) => (/^#(424242|2F7889)$/i.test(c) ? "fill:#000000" : "fill:#FFFFFF")) : inner);
// place the mic centred in a 1024 box at scale s (artwork spans x≈20..104, y≈4..128; stem bottom is flat in the original)
export const placed = (pal, s) => `<g id="mic-art" transform="translate(512 512) scale(${s}) translate(-64 -62)">${mic(pal)}</g>`;
