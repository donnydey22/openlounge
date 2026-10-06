import { MicOff } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { AVATAR_PATH } from "@/lib/avatar-shape";

const SIZES = {
  xs: "h-7 w-7 text-[10px]",
  sm: "h-10 w-10 text-xs",
  md: "h-14 w-14 text-base",
  lg: "h-[72px] w-[72px] text-xl",
  xl: "h-28 w-28 text-3xl",
  /** Profile header: Clubhouse's profile photo is 22.5% of the screen width (96pt on a 428pt iPhone) */
  profile: "h-[min(22.5vw,115px)] w-[min(22.5vw,115px)] text-3xl",
} as const;

const DOT = {
  xs: "h-2 w-2 -right-0 -bottom-0 ring-1",
  sm: "h-2.5 w-2.5 right-0 bottom-0 ring-2",
  md: "h-3.5 w-3.5 right-0 bottom-0 ring-2",
  lg: "h-4 w-4 right-0.5 bottom-0.5 ring-2",
  xl: "h-5 w-5 right-1 bottom-1 ring-[3px]",
  profile: "h-5 w-5 right-1 bottom-1 ring-[3px]",
} as const;

/**
 * Avatar clipped to a Clubhouse-style squircle (clip-path #openlounge-hex in layout, AVATAR_PATH).
 * Rings are drawn as an SVG stroke of the same path so they follow the shape all the way around.
 * Speaking glow scales with `level` (0–1) when provided.
 */
export function Avatar({
  name,
  color,
  photo,
  size = "md",
  speaking = false,
  /** 0–1 audio level — scales glow intensity / pulse when speaking */
  level = 0,
  muted = false,
  showMuted = false,
  away = false,
  online,
  onPodium = false,
  className,
}: {
  name: string;
  color: string;
  photo?: string | null;
  size?: keyof typeof SIZES;
  speaking?: boolean;
  level?: number;
  muted?: boolean;
  showMuted?: boolean;
  away?: boolean;
  /** green = online, gray = offline; omit to hide the dot */
  online?: boolean;
  onPodium?: boolean;
  className?: string;
}) {
  const lvl = Math.max(0, Math.min(1, level));
  const showGlow = speaking || lvl > 0.02;
  // Clubhouse-like verbalize: ring scale + opacity track loudness
  const glowScale = 1 + Math.min(0.22, lvl * 0.45);
  const glowOpacity = 0.35 + Math.min(0.65, lvl * 1.2);
  const glowBlur = 4 + lvl * 14;

  return (
    <div className={cn("relative shrink-0", className)}>
      {showGlow && (
        <span
          className="speaking-glow openlounge-hex absolute -inset-[4px] pointer-events-none"
          style={{
            transform: `scale(${glowScale})`,
            opacity: glowOpacity,
            boxShadow: `0 0 ${glowBlur}px ${2 + lvl * 6}px rgba(52, 211, 153, ${0.35 + lvl * 0.45})`,
          }}
          aria-hidden
        >
          <ShapeOutline stroke={`rgba(52, 211, 153, ${0.55 + lvl * 0.4})`} />
        </span>
      )}
      {onPodium && (
        <span
          className="podium-ring openlounge-hex absolute -inset-[7px] pointer-events-none"
          aria-hidden
        >
          <ShapeOutline className="stroke-amber-400/80" />
        </span>
      )}

      <div
        className={cn(
          "openlounge-hex relative flex items-center justify-center font-semibold text-on-color/95 shadow-inner select-none transition-opacity",
          SIZES[size],
          away && "opacity-40",
        )}
        style={{ background: `linear-gradient(145deg, ${color}, ${shade(color, -28)})` }}
        aria-label={name}
      >
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" className="openlounge-hex absolute inset-0 h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="relative z-[1]">{initials(name)}</span>
        )}
      </div>

      {showMuted && muted && (
        <span className="absolute -right-1 -bottom-1 z-[2] flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 ring-2 ring-zinc-950">
          <MicOff className="h-3.5 w-3.5 text-zinc-300" />
        </span>
      )}

      {online !== undefined && !(showMuted && muted) && (
        <span
          className={cn("absolute z-[2] rounded-full ring-app", DOT[size], online ? "bg-emerald-400" : "bg-zinc-500")}
          title={online ? "Online" : "Offline"}
          aria-label={online ? "Online" : "Offline"}
        />
      )}
    </div>
  );
}

/**
 * 2px outline that follows the avatar shape. The stroke is 4px centred on the path; the parent's
 * clip-path trims the outer half, leaving a 2px ring inside the edge (same as the old 2px border).
 */
function ShapeOutline({ stroke, className }: { stroke?: string; className?: string }) {
  return (
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
      <path d={AVATAR_PATH} fill="none" stroke={stroke} strokeWidth={4} vectorEffect="non-scaling-stroke" className={className} />
    </svg>
  );
}

function shade(hex: string, pct: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (c * pct) / 100)));
  const r = f(n >> 16),
    g = f((n >> 8) & 0xff),
    b = f(n & 0xff);
  return `rgb(${r}, ${g}, ${b})`;
}
