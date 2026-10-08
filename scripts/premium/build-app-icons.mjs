// Premium custom app icons: recolour src/app/icon.svg (gradient stops only; same mark) into variants and render
// PNGs for the web (180 apple-touch, 192/512) and the native shells (1024 master).
// Usage: node scripts/premium/build-app-icons.mjs   → public/app-icons/<id>.svg, <id>-{180,192,512}.png  (--native: 1024 masters for the shells)
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const SRC = fs.readFileSync("src/app/icon.svg", "utf8");
// classic stops: light #34D399, mid #10B981, dark #047857, accent #059669, glow #6EE7B7, shade #022C22
const VARIANTS = {
  midnight: ["#818CF8", "#4F46E5", "#1E1B4B", "#3730A3", "#C7D2FE", "#0B0A24"],
  sunset: ["#FDBA74", "#F97316", "#9A3412", "#EA580C", "#FED7AA", "#431407"],
  ocean: ["#67E8F9", "#0EA5E9", "#075985", "#0284C7", "#A5F3FC", "#082F49"],
  gold: ["#FDE68A", "#F59E0B", "#92400E", "#D97706", "#FEF3C7", "#451A03"],
  mono: ["#A1A1AA", "#52525B", "#18181B", "#3F3F46", "#E4E4E7", "#09090B"],
};
const KEYS = ["#34D399", "#10B981", "#047857", "#059669", "#6EE7B7", "#022C22"];
const out = "public/app-icons";
fs.mkdirSync(out, { recursive: true });
for (const [id, cols] of Object.entries(VARIANTS)) {
  let svg = SRC;
  KEYS.forEach((k, i) => (svg = svg.replaceAll(k, `__${i}__`)));
  cols.forEach((c, i) => (svg = svg.replaceAll(`__${i}__`, c)));
  fs.writeFileSync(path.join(out, `${id}.svg`), svg);
  for (const size of process.argv.includes("--native") ? [1024] : [180, 192, 512]) {
    await sharp(Buffer.from(svg), { density: Math.ceil((72 * size) / 1024) * 2 })
      .resize(size, size)
      .png({ compressionLevel: 9, palette: size <= 192 })
      .toFile(path.join(out, `${id}-${size}.png`));
  }
}
// classic preview for the picker
await sharp(Buffer.from(SRC)).resize(180, 180).png({ palette: true }).toFile(path.join(out, "classic-180.png"));
console.log("wrote", fs.readdirSync(out).length, "files to", out);
