// Sponsored messages store (/sp/* route handlers). Postgres tables from migration 021; without DATABASE_URL
// (local dev) a small JSON file in DATA_DIR. OFF by default (master switch 'off', new ads disabled).
// Privacy: nothing about the viewer is used for selection (placement + schedule + group size only) and nothing
// is logged per view or click. Per-user state is only "I hid this" and reports.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import pg from "pg";

export type Placement = "rooms" | "groups";
export type SponsoredAd = {
  id: string;
  advertiser: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  placements: Placement[];
  minGroupSize: number;
  startsAt: number;
  endsAt: number | null;
  enabled: boolean;
  avatar: string | null; // /sp/img/<id>-a-<v>.jpg
  image: { src: string; w: number; h: number } | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};
export type AdInput = Partial<Omit<SponsoredAd, "id" | "avatar" | "image" | "version" | "createdAt" | "updatedAt">> & {
  avatarData?: string | null; // data: URL from the admin form (null = remove)
  imageData?: string | null;
};
export const REPORT_REASONS = ["misleading", "scam", "offensive", "irrelevant", "other"] as const;

const LIMITS = { advertiser: 48, title: 80, body: 300, cta: 24, url: 2048 };
const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim()
    .slice(0, max);

export function validate(input: AdInput, partial: boolean): { ok: true; v: AdInput } | { ok: false; error: string } {
  const v: AdInput = {};
  if (!partial || input.advertiser !== undefined) {
    v.advertiser = clean(input.advertiser, LIMITS.advertiser);
    if (!v.advertiser) return { ok: false, error: "Advertiser name is required" };
  }
  if (!partial || input.title !== undefined) {
    v.title = clean(input.title, LIMITS.title);
    if (!v.title) return { ok: false, error: "Title is required" };
  }
  if (!partial || input.body !== undefined) v.body = clean(input.body, LIMITS.body);
  if (!partial || input.ctaLabel !== undefined) v.ctaLabel = clean(input.ctaLabel, LIMITS.cta) || "Learn more";
  if (!partial || input.ctaUrl !== undefined) {
    const raw = clean(input.ctaUrl, LIMITS.url);
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, error: "Button link must be a full https:// address" };
    }
    if (u.protocol !== "https:" || u.username || u.password) return { ok: false, error: "Button link must be a plain https:// address" };
    v.ctaUrl = u.toString();
  }
  if (!partial || input.placements !== undefined) {
    const p = (Array.isArray(input.placements) ? input.placements : []).filter((x): x is Placement => x === "rooms" || x === "groups");
    if (!p.length) return { ok: false, error: "Pick at least one placement" };
    v.placements = [...new Set(p)];
  }
  if (!partial || input.minGroupSize !== undefined) v.minGroupSize = Math.max(10, Math.min(100_000, Math.round(Number(input.minGroupSize) || 100)));
  if (!partial || input.startsAt !== undefined) v.startsAt = Number(input.startsAt) > 0 ? Math.round(Number(input.startsAt)) : Date.now();
  if (!partial || input.endsAt !== undefined) v.endsAt = input.endsAt ? Math.round(Number(input.endsAt)) : null;
  if (v.endsAt && v.startsAt && v.endsAt <= v.startsAt) return { ok: false, error: "End must be after start" };
  if (input.enabled !== undefined) v.enabled = !!input.enabled;
  if (input.avatarData !== undefined) v.avatarData = input.avatarData;
  if (input.imageData !== undefined) v.imageData = input.imageData;
  return { ok: true, v };
}

// ---- images: decode data: URL, re-encode with sharp (strips metadata, kills SVG/polyglots) ----
type SharpFn = (input: Buffer, opts?: Record<string, unknown>) => {
  rotate: () => ReturnType<SharpFn>;
  resize: (o: Record<string, unknown>) => ReturnType<SharpFn>;
  flatten: (o: Record<string, unknown>) => ReturnType<SharpFn>;
  jpeg: (o: Record<string, unknown>) => ReturnType<SharpFn>;
  toBuffer: (o: { resolveWithObject: true }) => Promise<{ data: Buffer; info: { width: number; height: number } }>;
};
let sharpP: Promise<SharpFn | null> | null = null;
const loadSharp = () =>
  (sharpP ??= import("sharp")
    .then((m) => (m.default ?? m) as unknown as SharpFn)
    .catch(() => {
      // tsx/CJS contexts can't always resolve a bare dynamic import; fall back to require from the app root
      try {
        return createRequire(path.join(process.cwd(), "package.json"))("sharp") as SharpFn;
      } catch (e) {
        console.warn("[sp] sharp unavailable", (e as Error).message);
        return null;
      }
    }));

export async function encodeImage(dataUrl: string, max: number): Promise<{ data: Buffer; w: number; h: number } | null> {
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 6 * 1024 * 1024) return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const out = await sharp(buf, { limitInputPixels: 40_000_000, animated: false })
      .rotate()
      .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#18181b" })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data: out.data, w: out.info.width, h: out.info.height };
  } catch (e) {
    console.warn("[sp] image encode failed", (e as Error).message);
    return null;
  }
}

// ---- storage ----
type Row = Omit<SponsoredAd, "avatar" | "image"> & { hasAvatar: boolean; imageW: number | null; imageH: number | null; hasImage: boolean };
interface Store {
  getEnabled(): Promise<boolean>;
  setEnabled(on: boolean): Promise<void>;
  list(): Promise<Row[]>;
  get(id: string): Promise<Row | null>;
  upsert(id: string, fields: AdInput & { avatar?: Buffer | null; image?: { data: Buffer; w: number; h: number } | null }, by: string): Promise<void>;
  remove(id: string): Promise<void>;
  img(id: string, kind: "a" | "i"): Promise<Buffer | null>;
  hidden(userId: string): Promise<Set<string>>;
  hide(userId: string, id: string): Promise<void>;
  report(userId: string, id: string, reason: string): Promise<void>;
}

const G = globalThis as unknown as { __olSpPool?: pg.Pool };
function pgPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!G.__olSpPool) {
    let connectionString = url;
    let ssl: pg.PoolConfig["ssl"];
    try {
      const u = new URL(url);
      const mode = (process.env.DATABASE_SSL || u.searchParams.get("sslmode") || "").toLowerCase();
      u.searchParams.delete("sslmode");
      u.searchParams.delete("uselibpqcompat");
      connectionString = u.toString();
      const host = u.hostname.toLowerCase();
      if (["disable", "off", "false", "0", "allow"].includes(mode)) ssl = false;
      else if (["verify", "verify-ca", "verify-full"].includes(mode)) ssl = { rejectUnauthorized: true };
      else if (mode || host.endsWith(".rlwy.net") || host.endsWith(".railway.app")) ssl = host.endsWith(".railway.internal") && !mode ? false : { rejectUnauthorized: false };
    } catch {
      /* keep */
    }
    const p = new pg.Pool({ connectionString, ssl, max: 2, idleTimeoutMillis: 30_000, statement_timeout: 4000, application_name: "openlounge-sponsored" });
    p.on("error", () => {});
    G.__olSpPool = p;
  }
  return G.__olSpPool;
}

const COLS = `id, advertiser, title, body, cta_label, cta_url, placements, min_group_size, starts_at, ends_at, enabled, version, created_at, updated_at,
  avatar_jpeg IS NOT NULL AS has_avatar, image_jpeg IS NOT NULL AS has_image, image_w, image_h`;
const fromRow = (r: Record<string, unknown>): Row => ({
  id: String(r.id),
  advertiser: String(r.advertiser),
  title: String(r.title),
  body: String(r.body),
  ctaLabel: String(r.cta_label),
  ctaUrl: String(r.cta_url),
  placements: (r.placements as Placement[]) ?? [],
  minGroupSize: Number(r.min_group_size),
  startsAt: Number(r.starts_at),
  endsAt: r.ends_at == null ? null : Number(r.ends_at),
  enabled: !!r.enabled,
  version: Number(r.version),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  hasAvatar: !!r.has_avatar,
  hasImage: !!r.has_image,
  imageW: r.image_w == null ? null : Number(r.image_w),
  imageH: r.image_h == null ? null : Number(r.image_h),
});

function pgStore(p: pg.Pool): Store {
  return {
    async getEnabled() {
      const r = await p.query("SELECT value FROM sponsored_settings WHERE key = 'enabled'");
      return r.rows[0]?.value === "on";
    },
    async setEnabled(on) {
      await p.query("INSERT INTO sponsored_settings (key, value) VALUES ('enabled', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [on ? "on" : "off"]);
    },
    async list() {
      return (await p.query(`SELECT ${COLS} FROM sponsored_messages ORDER BY created_at DESC LIMIT 200`)).rows.map(fromRow);
    },
    async get(id) {
      const r = await p.query(`SELECT ${COLS} FROM sponsored_messages WHERE id = $1`, [id]);
      return r.rows[0] ? fromRow(r.rows[0]) : null;
    },
    async upsert(id, f, by) {
      const now = Date.now();
      const exists = (await p.query("SELECT 1 FROM sponsored_messages WHERE id = $1", [id])).rowCount;
      if (!exists)
        await p.query(
          `INSERT INTO sponsored_messages (id, advertiser, title, body, cta_label, cta_url, placements, min_group_size, starts_at, ends_at, enabled, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$12)`,
          [id, f.advertiser, f.title, f.body ?? "", f.ctaLabel ?? "Learn more", f.ctaUrl, f.placements, f.minGroupSize ?? 100, f.startsAt ?? now, f.endsAt ?? null, by, now],
        );
      const sets: string[] = [];
      const vals: unknown[] = [id];
      const set = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (exists) {
        if (f.advertiser !== undefined) set("advertiser", f.advertiser);
        if (f.title !== undefined) set("title", f.title);
        if (f.body !== undefined) set("body", f.body);
        if (f.ctaLabel !== undefined) set("cta_label", f.ctaLabel);
        if (f.ctaUrl !== undefined) set("cta_url", f.ctaUrl);
        if (f.placements !== undefined) set("placements", f.placements);
        if (f.minGroupSize !== undefined) set("min_group_size", f.minGroupSize);
        if (f.startsAt !== undefined) set("starts_at", f.startsAt);
        if (f.endsAt !== undefined) set("ends_at", f.endsAt);
      }
      if (f.enabled !== undefined) set("enabled", f.enabled);
      if (f.avatar !== undefined) set("avatar_jpeg", f.avatar);
      if (f.image !== undefined) {
        set("image_jpeg", f.image?.data ?? null);
        set("image_w", f.image?.w ?? null);
        set("image_h", f.image?.h ?? null);
      }
      if (sets.length) await p.query(`UPDATE sponsored_messages SET ${sets.join(", ")}, version = version + 1, updated_at = ${now} WHERE id = $1`, vals);
    },
    async remove(id) {
      await p.query("DELETE FROM sponsored_messages WHERE id = $1", [id]);
      await p.query("DELETE FROM sponsored_hides WHERE sponsored_id = $1", [id]);
    },
    async img(id, kind) {
      const r = await p.query(`SELECT ${kind === "a" ? "avatar_jpeg" : "image_jpeg"} AS b FROM sponsored_messages WHERE id = $1`, [id]);
      return (r.rows[0]?.b as Buffer | null) ?? null;
    },
    async hidden(userId) {
      return new Set((await p.query("SELECT sponsored_id FROM sponsored_hides WHERE user_id = $1", [userId])).rows.map((x) => String(x.sponsored_id)));
    },
    async hide(userId, id) {
      await p.query("INSERT INTO sponsored_hides (user_id, sponsored_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [userId, id, Date.now()]);
    },
    async report(userId, id, reason) {
      await p.query("INSERT INTO sponsored_reports (user_id, sponsored_id, reason, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [userId, id, reason, Date.now()]);
      await this.hide(userId, id);
    },
  };
}

// JSON fallback (local dev): DATA_DIR/sponsored.json + DATA_DIR/sponsored-img/
type JState = { enabled: boolean; ads: Row[]; hides: [string, string][]; reports: { userId: string; id: string; reason: string; at: number }[] };
function jsonStore(): Store {
  const dir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const file = path.join(dir, "sponsored.json");
  const imgDir = path.join(dir, "sponsored-img");
  const read = (): JState => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as JState;
    } catch {
      return { enabled: false, ads: [], hides: [], reports: [] };
    }
  };
  const write = (s: JState) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(s));
    fs.renameSync(file + ".tmp", file);
  };
  return {
    async getEnabled() {
      return read().enabled;
    },
    async setEnabled(on) {
      const s = read();
      s.enabled = on;
      write(s);
    },
    async list() {
      return read().ads.sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(id) {
      return read().ads.find((a) => a.id === id) ?? null;
    },
    async upsert(id, f, by) {
      void by;
      const s = read();
      const now = Date.now();
      let a = s.ads.find((x) => x.id === id);
      if (!a) {
        a = { id, advertiser: "", title: "", body: "", ctaLabel: "Learn more", ctaUrl: "", placements: ["rooms"], minGroupSize: 100, startsAt: now, endsAt: null, enabled: false, version: 0, createdAt: now, updatedAt: now, hasAvatar: false, hasImage: false, imageW: null, imageH: null };
        s.ads.push(a);
      }
      for (const k of ["advertiser", "title", "body", "ctaLabel", "ctaUrl", "placements", "minGroupSize", "startsAt", "endsAt", "enabled"] as const)
        if (f[k] !== undefined) (a as Record<string, unknown>)[k] = f[k];
      fs.mkdirSync(imgDir, { recursive: true });
      if (f.avatar !== undefined) {
        a.hasAvatar = !!f.avatar;
        if (f.avatar) fs.writeFileSync(path.join(imgDir, `${id}-a.jpg`), f.avatar);
      }
      if (f.image !== undefined) {
        a.hasImage = !!f.image;
        a.imageW = f.image?.w ?? null;
        a.imageH = f.image?.h ?? null;
        if (f.image) fs.writeFileSync(path.join(imgDir, `${id}-i.jpg`), f.image.data);
      }
      a.version += 1;
      a.updatedAt = now;
      write(s);
    },
    async remove(id) {
      const s = read();
      s.ads = s.ads.filter((a) => a.id !== id);
      s.hides = s.hides.filter(([, x]) => x !== id);
      write(s);
    },
    async img(id, kind) {
      try {
        return fs.readFileSync(path.join(imgDir, `${id}-${kind}.jpg`));
      } catch {
        return null;
      }
    },
    async hidden(userId) {
      return new Set(read().hides.filter(([u]) => u === userId).map(([, id]) => id));
    },
    async hide(userId, id) {
      const s = read();
      if (!s.hides.some(([u, x]) => u === userId && x === id)) s.hides.push([userId, id]);
      write(s);
    },
    async report(userId, id, reason) {
      const s = read();
      if (!s.reports.some((r) => r.userId === userId && r.id === id)) s.reports.push({ userId, id, reason, at: Date.now() });
      if (!s.hides.some(([u, x]) => u === userId && x === id)) s.hides.push([userId, id]);
      write(s);
    },
  };
}

export function store(): Store {
  const p = pgPool();
  return p ? pgStore(p) : jsonStore();
}

export function toPublic(r: Row): SponsoredAd {
  return {
    id: r.id,
    advertiser: r.advertiser,
    title: r.title,
    body: r.body,
    ctaLabel: r.ctaLabel,
    ctaUrl: r.ctaUrl,
    placements: r.placements,
    minGroupSize: r.minGroupSize,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    enabled: r.enabled,
    avatar: r.hasAvatar ? `/sp/img/${r.id}-a-${r.version}.jpg` : null,
    image: r.hasImage && r.imageW && r.imageH ? { src: `/sp/img/${r.id}-i-${r.version}.jpg`, w: r.imageW, h: r.imageH } : null,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** the single ad for a view (max 1 per view): enabled, in schedule, right placement, big enough group, not hidden */
export async function pickAd(userId: string, placement: Placement, groupSize: number): Promise<SponsoredAd | null> {
  const s = store();
  if (!(await s.getEnabled())) return null;
  const now = Date.now();
  const hidden = await s.hidden(userId);
  const ads = (await s.list()).filter(
    (a) =>
      a.enabled &&
      a.startsAt <= now &&
      (!a.endsAt || a.endsAt > now) &&
      a.placements.includes(placement) &&
      (placement !== "groups" || groupSize >= a.minGroupSize) &&
      !hidden.has(a.id),
  );
  if (!ads.length) return null;
  // rotate fairly but stably within a 10-minute window (no per-user targeting)
  const slot = Math.floor(now / 600_000) % ads.length;
  return toPublic(ads[slot]);
}

export const newAdId = () => `sp_${randomBytes(9).toString("base64url")}`;
