import { Ghost, MicOff } from "lucide-react";
import { DELETED_COLOR, isDeletedName } from "@/lib/userDisplay";
import { cn, initials } from "@/lib/utils";
import { AVATAR_PATH } from "@/lib/avatar-shape";

const SIZES = {
  xs: "h-7 w-7 text-[10px]",
  /** in-app notification banner */
  banner: "h-9 w-9 text-[11px]",
  sm: "h-10 w-10 text-xs",
  md: "h-14 w-14 text-base",
  lg: "h-[72px] w-[72px] text-xl",
  xl: "h-28 w-28 text-3xl",
  /** Profile header: Clubhouse's profile photo is 22.5% of the screen width (96pt on a 428pt iPhone) */
  profile: "h-[min(22.5vw,115px)] w-[min(22.5vw,115px)] text-3xl",
} as const;

/** In-room presence dot: sits on the squircle edge at the bottom-left diagonal (13% in from each side). */
const ROOM_DOT = {
  xs: { size: 8, ring: 1.5 },
  banner: { size: 8, ring: 1.5 },
  sm: { size: 9, ring: 2 },
  md: { size: 10, ring: 2 },
  lg: { size: 12, ring: 2.5 },
  xl: { size: 16, ring: 3 },
  profile: { size: 16, ring: 3 },
} as const;

const DOT = {
  xs: "h-2 w-2 -right-0 -bottom-0 ring-1",
  banner: "h-2.5 w-2.5 -right-0.5 -bottom-0.5 ring-2",
  sm: "h-2.5 w-2.5 right-0 bottom-0 ring-2",
  md: "h-3.5 w-3.5 right-0 bottom-0 ring-2",
  lg: "h-4 w-4 right-0.5 bottom-0.5 ring-2",
  xl: "h-5 w-5 right-1 bottom-1 ring-[3px]",
  profile: "h-5 w-5 right-1 bottom-1 ring-[3px]",
} as const;

/**
 * Avatar clipped to a Clubhouse-style squircle (clip-path #openlounge-hex in layout, AVATAR_PATH).
 * Speaking glow is a soft outer ring (no clip-path on the glow itself — clip would kill box-shadow /
 * drop-shadow bloom). Intensity tracks LiveKit audioLevel when provided.
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
  presence,
  onPodium = false,
  deleted,
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
  /** In-room live presence (bottom-left): green = here, amber = backgrounded / reconnecting; omit to hide */
  presence?: "online" | "away" | null;
  onPodium?: boolean;
  /** deleted account: grey ghost avatar (also inferred from the name "Deleted Account" with no photo) */
  deleted?: boolean;
  className?: string;
}) {
  const ghost = deleted ?? (isDeletedName(name) && !photo);
  if (ghost) {
    color = DELETED_COLOR;
    photo = null;
  }
  const lvl = Math.max(0, Math.min(1, level));
  const showGlow = speaking || lvl > 0.02;
  // Clubhouse-like verbalize: ring scale + opacity track loudness
  const glowScale = 1 + Math.min(0.18, lvl * 0.4);
  const glowOpacity = speaking || lvl > 0.02 ? 0.55 + Math.min(0.45, lvl * 0.9) : 0;
  const glowBlur = 3 + lvl * 10;
  const strokeAlpha = 0.55 + Math.min(0.4, lvl * 0.7);
  const bloomAlpha = 0.22 + Math.min(0.38, lvl * 0.55);
  const strokeW = 2.25 + lvl * 1.75;

  return (
    <div className={cn("relative shrink-0", className)}>
      {showGlow && (
        <span
          className="speaking-glow pointer-events-none absolute -inset-[6px]"
          style={{
            transform: `scale(${glowScale})`,
            opacity: glowOpacity,
          }}
          aria-hidden
        >
          {/* Soft bloom: blurred squircle fill (clip only the fill, blur blooms outside) */}
          <span
            className="speaking-glow-bloom absolute inset-[3px]"
            style={{
              background: `rgba(var(--speaking-glow-rgb), ${bloomAlpha})`,
              filter: `blur(${glowBlur}px)`,
              WebkitClipPath: "url(#openlounge-hex)",
              clipPath: "url(#openlounge-hex)",
            }}
          />
          {/* Soft ring stroke — no clip-path so drop-shadow can bloom */}
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            <path
              d={AVATAR_PATH}
              fill="none"
              stroke={`rgba(var(--speaking-glow-rgb), ${strokeAlpha})`}
              strokeWidth={strokeW}
              vectorEffect="non-scaling-stroke"
              style={{
                filter: `drop-shadow(0 0 ${5 + lvl * 8}px rgba(var(--speaking-glow-rgb), ${0.45 + lvl * 0.35}))`,
              }}
            />
          </svg>
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
        {ghost ? (
          <Ghost className="relative z-[1] h-[55%] w-[55%] text-white/80" aria-hidden />
        ) : photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" className="openlounge-hex absolute inset-0 h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="relative z-[1]">{initials(name)}</span>
        )}
      </div>

      {showMuted && muted && (
        <span className="absolute -right-1 -bottom-1 z-[2] flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 ring-2 ring-zinc-950">
          <MicOff className="h-3.5 w-3.5 text-red-400" />
        </span>
      )}

      {presence && (
        <span
          key={presence}
          data-presence={presence}
          className={cn(
            "presence-dot pointer-events-none absolute z-[2] rounded-full",
            presence === "online" ? "bg-emerald-400" : "bg-amber-400",
          )}
          style={{
            width: ROOM_DOT[size].size,
            height: ROOM_DOT[size].size,
            left: `calc(13% - ${ROOM_DOT[size].size / 2}px)`,
            bottom: `calc(13% - ${ROOM_DOT[size].size / 2}px)`,
            boxShadow: `0 0 0 ${ROOM_DOT[size].ring}px var(--color-app)`,
          }}
          title={presence === "online" ? "Here now" : "Away"}
          role="img"
          aria-label={presence === "online" ? "Here now" : "Away"}
        />
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
