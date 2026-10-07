// Regenerates the iOS/Expo icon + splash artwork from the Android launcher icon so both stores ship the same mark.
// Source of truth: openlounge/android/app/src/main/res/drawable/ic_launcher_foreground.xml (108dp adaptive-icon
// canvas) + values/colors.xml (openlounge_bg #1C1C1E). Android launchers show only the central 72x72dp of the
// adaptive canvas (the outer 18dp is mask/parallax bleed), so the iOS icon renders viewBox "18 18 72 72" — the
// mark is the same size on both home screens.
//
// Usage (dev only, not an app dependency — sharp is borrowed from the web repo):
//   SHARP=/workspace/openlounge/node_modules/sharp node scripts/generate-assets.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP || '/workspace/openlounge/node_modules/sharp');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (f) => path.join(root, 'assets', f);

const BG = '#1C1C1E'; // android openlounge_bg
// android/app/src/main/res/drawable/ic_launcher_foreground.xml, verbatim path data
const MIC = `
  <path fill="#F2B366" d="M54,34c-7.7,0 -14,6.3 -14,14v8c0,7.7 6.3,14 14,14s14,-6.3 14,-14v-8c0,-7.7 -6.3,-14 -14,-14z"/>
  <path fill="#5B8C5A" d="M40,60c0,7.7 6.3,14 14,14s14,-6.3 14,-14h-4c0,5.5 -4.5,10 -10,10s-10,-4.5 -10,-10h-4z"/>
  <path fill="#F2B366" d="M52,74h4v8h-4z"/>`;

const svg = (body, viewBox = '18 18 72 72') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="${viewBox}">${body}</svg>`);

async function main() {
  // iOS app icon: 1024x1024, opaque (App Store rejects alpha), square — iOS applies its own squircle mask.
  await sharp(svg(`<rect x="0" y="0" width="108" height="108" fill="${BG}"/>${MIC}`))
    .flatten({ background: BG })
    .removeAlpha()
    .png()
    .toFile(out('icon.png'));

  // Splash mark: what Android 12+'s system splash shows — the adaptive icon masked to a circle (bg layer + mark).
  // On the dark splash (#1C1C1E) the circle is invisible (same colour) → identical to Android; on the light splash
  // it reads as the icon badge.
  await sharp(svg(`<circle cx="54" cy="54" r="36" fill="${BG}"/>${MIC}`)).png().toFile(out('splash-icon.png'));

  // Android adaptive foreground (full 108 canvas, transparent) — kept in sync for the Expo Android target.
  await sharp(svg(MIC, '0 0 108 108')).png().toFile(out('adaptive-icon.png'));

  // Favicon (web target only).
  await sharp(svg(`<rect x="0" y="0" width="108" height="108" fill="${BG}"/>${MIC}`))
    .resize(48, 48)
    .flatten({ background: BG })
    .removeAlpha()
    .png()
    .toFile(out('favicon.png'));

  for (const f of ['icon.png', 'splash-icon.png', 'adaptive-icon.png', 'favicon.png']) {
    const m = await sharp(out(f)).metadata();
    console.log(f, `${m.width}x${m.height}`, `channels=${m.channels}`, `alpha=${m.hasAlpha}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
