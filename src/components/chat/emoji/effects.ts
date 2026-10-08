// Full-screen particle effects for reactions and emoji interactions (Telegram-style "effect" animations).
// One shared, pointer-transparent <canvas> over the app; a single rAF loop runs only while particles are alive.
// Each emoji family has its own choreography: hearts float up, confetti flutters down, fireworks burst, fire throws
// embers, laughter / tears splash droplets, hands / stars twinkle; everything else sprays mini copies.
// Mini copies use the emoji's own poster image when it's loaded (Telegram look), else the native glyph.

import { animatedAsset } from "@/lib/emoji/assets";
import { prefersReducedMotion } from "./AnimatedEmoji";

type Kind = "hearts" | "confetti" | "fireworks" | "fire" | "drops" | "sparkle" | "spray";
const FAMILY: [RegExp, Kind][] = [
  [/^(❤|🧡|💛|💚|💙|💜|🖤|🤍|🤎|💖|💗|💓|💞|💕|💘|💝|😍|🥰|😘|💋|🌹|❣)/u, "hearts"],
  [/^(🎉|🎊|🥳|🎈|🎂|🎁|🪅)/u, "confetti"],
  [/^(🎆|🎇|✨|💥|🚀|🤯|🌟|💫)/u, "fireworks"],
  [/^(🔥|❤️‍🔥|🥵|☄|🌶)/u, "fire"],
  [/^(😂|🤣|😭|😢|🥲|😅|💧|💦|🌊|😰|😥)/u, "drops"],
  [/^(👍|👏|🙌|💯|⭐|🏆|🥇|👌|🤝|🙏|💪|✌|🤞|😎|🤩|👑|💎)/u, "sparkle"],
];
const kindOf = (e: string): Kind => FAMILY.find(([re]) => re.test(e))?.[1] ?? "spray";

type P = {
  x: number; y: number; vx: number; vy: number; ax: number; ay: number; drag: number;
  life: number; age: number; size: number; rot: number; vr: number; hue: number;
  shape: "sprite" | "rect" | "dot" | "spark" | "star" | "drop" | "ring" | "dust";
  sprite?: CanvasImageSource; phase: number; sway: number; grow: number; additive?: boolean; px?: number; py?: number;
};

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let dpr = 1;
let parts: P[] = [];
let raf = 0;
let last = 0;

function ensure() {
  if (canvas || typeof document === "undefined") return;
  canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.testid = "fx-canvas";
  Object.assign(canvas.style, { position: "fixed", left: "0", top: "0", pointerEvents: "none", zIndex: "95" });
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d");
  const fit = () => {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  };
  fit();
  window.addEventListener("resize", fit, { passive: true });
}

const glyphs = new Map<string, HTMLCanvasElement>();
function glyph(e: string) {
  let c = glyphs.get(e);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = 72;
    const g = c.getContext("2d")!;
    g.font = '56px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(e, 36, 40);
    glyphs.set(e, c);
  }
  return c;
}
const posters = new Map<string, HTMLImageElement>();
function sprite(e: string): CanvasImageSource {
  const a = animatedAsset(e);
  if (a?.poster) {
    let img = posters.get(a.poster);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = a.poster;
      posters.set(a.poster, img);
    }
    if (img.complete && img.naturalWidth) return img;
  }
  return glyph(e);
}
/** Warm the poster so the first burst already uses it. */
export function warmEffect(e: string) {
  if (typeof document !== "undefined") sprite(e);
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const HEART_SPRITE = () => sprite("❤️");

function spawn(x: number, y: number, emoji: string, big: boolean) {
  const k = kindOf(emoji);
  const W = window.innerWidth;
  const H = window.innerHeight;
  const scale = big ? 1.55 : 1;
  const base = { ax: 0, ay: 0, drag: 0.985, age: 0, rot: 0, vr: 0, hue: 0, phase: Math.random() * 6.28, sway: 0, grow: 0 };
  const add = (p: Partial<P> & Pick<P, "x" | "y" | "vx" | "vy" | "life" | "size" | "shape">) => parts.push({ ...base, ...p } as P);
  // shockwave ring — every effect gets a punchy start
  add({ x, y, vx: 0, vy: 0, life: 0.55, size: 18 * scale, shape: "ring", grow: (big ? 260 : 150), hue: k === "fire" ? 28 : k === "hearts" ? 350 : 150 });
  const me = sprite(emoji);
  switch (k) {
    case "hearts": {
      const n = big ? 34 : 16;
      const heart = /^(❤|😍|🥰|😘|💋|🌹|❣)/u.test(emoji) ? HEART_SPRITE() : me;
      for (let i = 0; i < n; i++) {
        const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05);
        const sp = rnd(140, big ? 620 : 380);
        add({ x: x + rnd(-10, 10), y: y + rnd(-6, 6), vx: Math.cos(a) * sp * 0.8, vy: Math.sin(a) * sp, ay: -40, drag: 0.972, life: rnd(1.1, big ? 2.2 : 1.6), size: rnd(14, big ? 40 : 28), shape: "sprite", sprite: i % 4 === 0 ? me : heart, sway: rnd(18, 46), vr: rnd(-1.5, 1.5) });
      }
      break;
    }
    case "confetti": {
      const n = big ? 120 : 60;
      for (let i = 0; i < n; i++) {
        const a = rnd(-Math.PI * 0.92, -Math.PI * 0.08);
        const sp = rnd(260, big ? 980 : 620);
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ay: 900, drag: 0.955, life: rnd(1.3, big ? 2.6 : 1.9), size: rnd(6, 11), shape: "rect", hue: [350, 45, 150, 200, 280, 20][i % 6] + rnd(-12, 12), vr: rnd(-14, 14), sway: rnd(10, 30) });
      }
      for (let i = 0; i < (big ? 8 : 4); i++) add({ x, y, vx: rnd(-260, 260), vy: rnd(-700, -380), ay: 700, drag: 0.97, life: rnd(1.2, 1.8), size: rnd(18, 28), shape: "sprite", sprite: me, vr: rnd(-4, 4) });
      break;
    }
    case "fireworks": {
      const bursts = big ? 4 : 2;
      for (let b = 0; b < bursts; b++) {
        const cx = b === 0 ? x : x + rnd(-W * 0.32, W * 0.32);
        const cy = b === 0 ? y : Math.max(60, y - rnd(H * 0.12, H * 0.38));
        const hue = rnd(0, 360);
        const n = big ? 44 : 30;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rnd(-0.08, 0.08);
          const sp = rnd(220, big ? 520 : 380);
          add({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ay: 260, drag: 0.94, life: rnd(0.9, 1.4) + b * 0.12, age: -b * 0.16, size: rnd(2, 3.4), shape: "spark", hue: hue + rnd(-20, 20), additive: true });
        }
      }
      break;
    }
    case "fire": {
      const n = big ? 90 : 46;
      for (let i = 0; i < n; i++)
        add({ x: x + rnd(-22, 22) * scale, y: y + rnd(-8, 12), vx: rnd(-90, 90), vy: rnd(-520, -160) * scale, ay: -120, drag: 0.975, life: rnd(0.7, big ? 1.8 : 1.2), size: rnd(2.5, 6.5), shape: "dot", hue: rnd(12, 48), additive: true, sway: rnd(20, 60) });
      for (let i = 0; i < (big ? 7 : 3); i++) add({ x, y, vx: rnd(-160, 160), vy: rnd(-520, -300), ay: -60, drag: 0.97, life: rnd(1.0, 1.5), size: rnd(18, 30), shape: "sprite", sprite: me, sway: 24 });
      break;
    }
    case "drops": {
      const n = big ? 44 : 22;
      for (let i = 0; i < n; i++) {
        const side = i % 2 ? 1 : -1;
        add({ x: x + side * rnd(8, 22), y: y - rnd(4, 14), vx: side * rnd(120, big ? 520 : 330), vy: rnd(-520, -220), ay: 1200, drag: 0.985, life: rnd(0.8, 1.3), size: rnd(4, 8), shape: "drop", hue: 205 });
      }
      for (let i = 0; i < (big ? 9 : 4); i++) add({ x, y, vx: rnd(-280, 280), vy: rnd(-560, -260), ay: 900, drag: 0.98, life: rnd(1.0, 1.6), size: rnd(16, 26), shape: "sprite", sprite: me, vr: rnd(-6, 6) });
      break;
    }
    case "sparkle": {
      const n = big ? 34 : 18;
      for (let i = 0; i < n; i++) {
        const a = rnd(0, Math.PI * 2);
        const sp = rnd(120, big ? 520 : 320);
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, drag: 0.93, life: rnd(0.7, 1.3), size: rnd(5, 12), shape: "star", hue: rnd(40, 58), vr: rnd(-3, 3), additive: true });
      }
      for (let i = 0; i < (big ? 10 : 5); i++) {
        const a = rnd(-Math.PI, 0);
        add({ x, y, vx: Math.cos(a) * rnd(160, 420), vy: Math.sin(a) * rnd(240, 520), ay: 500, drag: 0.975, life: rnd(1.0, 1.5), size: rnd(18, 30), shape: "sprite", sprite: me, vr: rnd(-5, 5) });
      }
      break;
    }
    default: {
      const n = big ? 22 : 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd(-0.2, 0.2);
        const sp = rnd(200, big ? 560 : 380);
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, ay: 520, drag: 0.965, life: rnd(1.0, 1.6), size: rnd(16, big ? 34 : 26), shape: "sprite", sprite: me, vr: rnd(-5, 5) });
      }
      for (let i = 0; i < (big ? 20 : 10); i++) {
        const a = rnd(0, Math.PI * 2);
        add({ x, y, vx: Math.cos(a) * rnd(100, 300), vy: Math.sin(a) * rnd(100, 300), drag: 0.92, life: rnd(0.5, 0.9), size: rnd(4, 8), shape: "star", hue: rnd(140, 170), additive: true });
      }
    }
  }
}

function drawStar(g: CanvasRenderingContext2D, r: number) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 ? r * 0.28 : r;
    const a = (i * Math.PI) / 4;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

function frame(t: number) {
  if (!ctx || !canvas) return;
  const dt = Math.min(0.033, last ? (t - last) / 1000 : 0.016);
  last = t;
  const g = ctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const alive: P[] = [];
  for (const p of parts) {
    p.age += dt;
    if (p.age < 0) {
      alive.push(p);
      continue;
    }
    if (p.age >= p.life) continue;
    alive.push(p);
    p.px = p.x;
    p.py = p.y;
    const damp = Math.pow(p.drag, dt * 60);
    p.vx = p.vx * damp + p.ax * dt;
    p.vy = p.vy * damp + p.ay * dt;
    p.x += p.vx * dt + (p.sway ? Math.sin(p.phase + p.age * 6) * p.sway * dt : 0);
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    const k = p.age / p.life;
    const fadeIn = Math.min(1, p.age / 0.08);
    const alpha = fadeIn * (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
    g.globalAlpha = Math.max(0, alpha);
    g.globalCompositeOperation = p.additive ? "lighter" : "source-over";
    switch (p.shape) {
      case "ring": {
        const r = p.size + p.grow * (1 - Math.pow(1 - k, 3));
        g.strokeStyle = `hsla(${p.hue},90%,65%,${0.55 * (1 - k)})`;
        g.lineWidth = 3 * (1 - k) + 0.5;
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.stroke();
        break;
      }
      case "sprite": {
        const s = p.size * (k < 0.15 ? 0.4 + (k / 0.15) * 0.75 : 1.15 - Math.min(0.15, (k - 0.15) * 0.4));
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        if (p.sprite) g.drawImage(p.sprite, -s / 2, -s / 2, s, s);
        g.restore();
        break;
      }
      case "rect": {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.scale(1, Math.cos(p.phase + p.age * 9));
        g.fillStyle = `hsl(${p.hue},88%,60%)`;
        g.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
        g.restore();
        break;
      }
      case "dust": {
        // hue < 0 → light grey (dark bubbles), else the bubble's accent hue
        g.fillStyle = p.hue < 0 ? `rgba(228,228,231,${0.85 * (1 - k)})` : `hsla(${p.hue},70%,55%,${0.9 * (1 - k)})`;
        const d = p.size * (1 - k * 0.5);
        g.fillRect(p.x - d / 2, p.y - d / 2, d, d);
        break;
      }
      case "dot": {
        g.fillStyle = `hsl(${p.hue - k * 18},100%,${62 - k * 20}%)`;
        g.beginPath();
        g.arc(p.x, p.y, p.size * (1 - k * 0.6), 0, Math.PI * 2);
        g.fill();
        break;
      }
      case "spark": {
        g.strokeStyle = `hsl(${p.hue},100%,${70 - k * 25}%)`;
        g.lineWidth = p.size;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(p.px! - p.vx * 0.03, p.py! - p.vy * 0.03);
        g.lineTo(p.x, p.y);
        g.stroke();
        break;
      }
      case "star": {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillStyle = `hsl(${p.hue},100%,72%)`;
        drawStar(g, p.size * (1 - k * 0.5) * (0.75 + 0.25 * Math.sin(p.age * 18 + p.phase)));
        g.restore();
        break;
      }
      case "drop": {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(Math.atan2(p.vy, p.vx) - Math.PI / 2);
        g.fillStyle = `hsla(${p.hue},90%,70%,0.95)`;
        g.beginPath();
        g.moveTo(0, -p.size * 1.6);
        g.quadraticCurveTo(p.size, 0, 0, p.size);
        g.quadraticCurveTo(-p.size, 0, 0, -p.size * 1.6);
        g.fill();
        g.restore();
        break;
      }
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  parts = alive;
  if (parts.length) raf = requestAnimationFrame(frame);
  else {
    raf = 0;
    last = 0;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/** Fire an effect at viewport point (x, y). `big` = full-screen emoji interaction; else a reaction-sized burst. */
export function burst(x: number, y: number, emoji: string, big = false) {
  if (typeof window === "undefined" || prefersReducedMotion()) return;
  ensure();
  if (parts.length > 900) parts.splice(0, parts.length - 600); // hammering taps: keep the frame budget
  spawn(x, y, emoji, big);
  if (!raf) raf = requestAnimationFrame(frame);
}

/** Telegram-style "dust" for a deleted message: the bubble's area crumbles into drifting specks. */
export function dust(r: { left: number; top: number; width: number; height: number }, accent = false) {
  if (typeof window === "undefined" || prefersReducedMotion()) return;
  ensure();
  const n = Math.min(220, Math.max(40, Math.round((r.width * r.height) / 90)));
  const base = { ax: 0, ay: -40, drag: 0.96, age: 0, rot: 0, vr: 0, phase: 0, sway: 0, grow: 0 };
  for (let i = 0; i < n; i++) {
    const fx = Math.random();
    parts.push({
      ...base,
      x: r.left + fx * r.width,
      y: r.top + Math.random() * r.height,
      vx: 60 + fx * 160 + rnd(-30, 30),
      vy: rnd(-120, -20),
      age: -fx * 0.25, // sweeps left → right
      life: rnd(0.55, 1.0),
      size: rnd(1.6, 3.4),
      shape: "dust",
      hue: accent ? 152 : -1,
    } as P);
  }
  if (!raf) raf = requestAnimationFrame(frame);
}

/** test hook: particles alive right now */
export const fxParticleCount = () => parts.length;
