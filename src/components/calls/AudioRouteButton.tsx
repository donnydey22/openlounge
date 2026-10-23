"use client";
// Call audio output: one button that always says WHERE the call plays — Speaker, Phone (earpiece), Headphones, or the
// Bluetooth device by name (AirPods) — with a distinct icon per route. Two built-in routes toggle on tap (Speaker ⇄
// Phone); once a headset/Bluetooth device is present (or on desktop with several outputs) the tap opens a picker, like
// WhatsApp/FaceTime. Browsers that cannot switch outputs (iOS Safari, Firefox) explain where to change it instead.
import { useState, type ReactNode } from "react";
import { Bluetooth, Car, Check, Ear, Headphones, Speaker, Volume2 } from "lucide-react";
import { callEngine, type CallSnapshot } from "@/lib/calls/engine";
import { isHeadsetKind, routeIcon, routeLabel, type AudioRoute, type RouteIcon } from "@/lib/calls/audioRoute";
import { cn } from "@/lib/utils";

type BtnProps = { label: string; onClick: () => void; active?: boolean; testId?: string; children: ReactNode };

export function RouteGlyph({ icon, className }: { icon: RouteIcon; className?: string }) {
  const c = cn("h-6 w-6", className);
  switch (icon) {
    case "speaker": return <Volume2 className={c} data-route="speaker" />;
    case "phone": return <Ear className={c} data-route="phone" />;
    case "headphones": return <Headphones className={c} data-route="headphones" />;
    case "bluetooth": return <Bluetooth className={c} data-route="bluetooth" />;
    case "car": return <Car className={c} data-route="car" />;
    default: return <Speaker className={c} data-route="system" />;
  }
}

/** true when a tap should open the picker instead of flipping Speaker ⇄ Phone */
export function routeNeedsPicker(s: Pick<CallSnapshot, "routes" | "routeSwitchable" | "route">): boolean {
  if (!s.routeSwitchable) return true;
  if (s.routes.some((r) => isHeadsetKind(r.kind)) || (s.route && isHeadsetKind(s.route.kind))) return true;
  const kinds = new Set(s.routes.map((r) => r.kind));
  // desktop browsers: device list (several speakers/headsets, no earpiece) → pick by name
  return !(kinds.size === 2 && kinds.has("speaker") && kinds.has("earpiece") && s.routes.length === 2);
}

export function AudioRouteButton({ s, Btn }: { s: CallSnapshot; Btn: (p: BtnProps) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const route = s.route ?? (s.speaker ? { id: "speaker", kind: "speaker", name: "" } : { id: "earpiece", kind: "earpiece", name: "" });
  const label = routeLabel(route as AudioRoute);
  const active = route.kind !== "earpiece" && route.kind !== "system";
  const onClick = () => (routeNeedsPicker(s) ? setOpen(true) : void callEngine.toggleSpeaker());
  return (
    <>
      <Btn label={label} active={active} onClick={onClick} testId="call-speaker">
        <RouteGlyph icon={routeIcon(route.kind as AudioRoute["kind"])} />
      </Btn>
      {open ? <RouteSheet s={s} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RouteSheet({ s, onClose }: { s: CallSnapshot; onClose: () => void }) {
  const current = s.route?.id;
  return (
    <div className="fixed inset-0 z-[80] flex items-end bg-black/40" onClick={onClose} data-testid="call-route-sheet">
      <div role="dialog" aria-label="Audio output" className="w-full rounded-t-3xl bg-zinc-900/95 p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] backdrop-blur-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" />
        <div className="px-4 pb-1 pt-1 text-[13px] font-semibold uppercase tracking-wide text-white/50">Audio</div>
        {s.routeSwitchable && s.routes.length ? (
          s.routes.map((r) => (
            <button
              key={r.id}
              type="button"
              data-testid={`call-route-option-${r.kind}`}
              aria-checked={r.id === current}
              role="menuitemradio"
              onClick={() => {
                void callEngine.selectRoute(r.id);
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-[15px] text-white hover:bg-white/10"
            >
              <RouteGlyph icon={routeIcon(r.kind)} className="h-5 w-5 text-white/85" />
              <span className="min-w-0 flex-1 truncate">{routeLabel(r)}</span>
              {r.id === current ? <Check className="h-5 w-5 text-emerald-400" /> : null}
            </button>
          ))
        ) : (
          <p className="px-4 py-3 text-[14px] leading-snug text-white/80" data-testid="call-route-system">
            Call audio plays on {s.route && s.route.kind !== "system" ? routeLabel(s.route) : "this device's current output"}. This browser can't switch it — use your device&apos;s sound settings (Control Center on iPhone) to choose speaker, headphones or Bluetooth.
          </p>
        )}
        <button type="button" onClick={onClose} className="mt-1 block w-full rounded-xl px-4 py-3 text-center text-[15px] font-semibold text-emerald-400 hover:bg-white/10">
          Done
        </button>
      </div>
    </div>
  );
}

/** "Audio on AirPods" — shown briefly when the route changes on its own (device connected/removed). */
export function RouteNotice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div role="status" aria-live="polite" data-testid="call-route-notice" className="pointer-events-none mx-auto mb-3 w-fit rounded-full bg-black/55 px-3 py-1.5 text-[13px] font-medium text-white backdrop-blur-md">
      {text}
    </div>
  );
}
