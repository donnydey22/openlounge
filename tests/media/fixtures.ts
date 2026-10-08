// Generated test media (ffmpeg + sharp): a JPEG with GPS EXIF, PNG with alpha, animated GIF, H.264 mp4, VP9 webm,
// voice notes as webm/opus (Chrome/Firefox) and mp4/aac (Safari), a PDF and a fake "photo" that is really text.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

export const FIX = fs.mkdtempSync(path.join(os.tmpdir(), "ol-media-fix-"));
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "pipe" });

export async function makeFixtures() {
  const f = (n: string) => path.join(FIX, n);
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 60, b: 90 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestPhone", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 26/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "112/1 4/1 0/1" } })
    .toFile(f("gps.jpg"));
  await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 0.5 } } }).png().toFile(f("alpha.png"));
  ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", f("anim.gif"));
  ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata", "location=+33.4484-112.0740/", "-shortest", f("h264.mp4"));
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1", "-c:v", "libvpx-vp9", "-b:v", "200k", f("vp9.webm"));
  ff("-f", "lavfi", "-i", "sine=frequency=300:duration=2", "-c:a", "libopus", "-b:a", "32k", f("voice.webm"));
  ff("-f", "lavfi", "-i", "sine=frequency=500:duration=1.5", "-c:a", "aac", "-b:a", "64k", "-f", "mp4", f("voice-safari.mp4"));
  fs.writeFileSync(f("doc.pdf"), "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  fs.writeFileSync(f("notes.txt"), "hello world\n".repeat(200));
  fs.writeFileSync(f("evil.html"), "<html><script>alert(1)</script></html>");
  return f;
}
