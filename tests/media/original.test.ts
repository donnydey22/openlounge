// "Download original" (Telegram-style): lossless metadata strip for JPEG / PNG originals. Pure unit tests, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { stripJpeg, stripPng } from "../../server/media/original";

const seg = (marker: number, body: Buffer) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
};
const noise = (w: number, h: number) => {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
};
const scan = (b: Buffer) => {
  // bytes from the first SOS to the first EOI after it: the compressed pixels
  let i = 2;
  while (b[i + 1] !== 0xda) i += 2 + b.readUInt16BE(i + 2);
  return b.subarray(i, b.indexOf(Buffer.from([0xff, 0xd9]), i) + 2);
};

test("JPEG original: GPS/camera EXIF, XMP-ish APPn, comments and appended MPF images dropped; pixels byte-identical; orientation kept", async () => {
  const base = await noise(900, 600)
    .jpeg({ quality: 92 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: "TestPhone", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 26/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "112/1 4/1 0/1" } })
    .toBuffer();
  assert.ok(base.includes(Buffer.from("TestPhone")));
  // splice in an APP13 (Photoshop/IPTC), a COM, an APP2 "MPF" index, and an appended secondary image after EOI
  const extra = Buffer.concat([seg(0xed, Buffer.from("Photoshop 3.0\0SecretCaption")), seg(0xfe, Buffer.from("SecretComment")), seg(0xe2, Buffer.from("MPF\0SecretIndex"))]);
  const tail = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.from("Exif\0\0SecretGainMapGPS")), Buffer.from([0xff, 0xd9])]);
  const src = Buffer.concat([base.subarray(0, 2), extra, base.subarray(2), tail]);
  const meta0 = await sharp(src).metadata();
  assert.equal(meta0.orientation, 6);

  const out = stripJpeg(src, meta0.orientation)!;
  assert.ok(out, "stripped");
  for (const s of ["TestPhone", "Secret"]) assert.equal(out.includes(Buffer.from(s)), false, `${s} gone`);
  assert.ok(scan(out).equals(scan(src)), "entropy-coded scan data identical (no re-encode)");
  const meta = await sharp(out).metadata();
  assert.equal(meta.orientation, 6, "orientation survives");
  assert.equal(meta.width, 900);
  assert.equal(meta.height, 600);
  const [a, b] = await Promise.all([sharp(src).raw().toBuffer(), sharp(out).raw().toBuffer()]);
  assert.ok(a.equals(b), "decoded pixels identical");
  // the trailing secondary image is gone: file ends at the primary EOI
  assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9]);
  assert.ok(out.length < src.length);

  // orientation 1 → no EXIF at all
  const plain = stripJpeg(src, 1)!;
  assert.equal((await sharp(plain).metadata()).exif, undefined);
  // ICC profile (APP2 ICC_PROFILE) is kept so colours stay right
  const icc = await noise(64, 64).jpeg().withIccProfile("p3").toBuffer();
  assert.ok((await sharp(stripJpeg(icc)!).metadata()).icc, "ICC kept");
});

test("JPEG/PNG strip refuses malformed input instead of guessing", () => {
  assert.equal(stripJpeg(Buffer.from("not a jpeg")), null);
  assert.equal(stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])), null, "segment length past EOF");
  assert.equal(stripPng(Buffer.from("not a png")), null);
});

test("PNG original: tEXt/iTXt/eXIf/tIME dropped, pixels and alpha identical", async () => {
  const png = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 0.5 } } }).png().toBuffer();
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdrEnd = 8 + 12 + 13;
  const src = Buffer.concat([png.subarray(0, ihdrEnd), chunk("tEXt", Buffer.from("Author\0SecretName")), chunk("eXIf", Buffer.from("MM\0*SecretGPS")), chunk("tIME", Buffer.alloc(7, 1)), png.subarray(ihdrEnd)]);
  const out = stripPng(src)!;
  assert.ok(out);
  assert.equal(out.includes(Buffer.from("Secret")), false);
  assert.equal(out.includes(Buffer.from("tIME")), false);
  const [a, b] = await Promise.all([sharp(src).raw().toBuffer(), sharp(out).raw().toBuffer()]);
  assert.ok(a.equals(b));
  assert.equal((await sharp(out).metadata()).hasAlpha, true);
});
