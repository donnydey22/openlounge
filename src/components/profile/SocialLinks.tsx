"use client";

import { Globe } from "lucide-react";
import { SOCIAL_KEYS, SOCIAL_LABELS, socialDisplay, type SocialKey, type SocialLinks } from "@/lib/socialLinks";

/** Monochrome brand glyphs (simple paths, currentColor) so chips follow the light/dark theme. */
const PATHS: Partial<Record<SocialKey, string>> = {
  instagram:
    "M12 2.2c3.2 0 3.6 0 4.8.1 3.3.1 4.8 1.7 4.9 4.9.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 3.2-1.7 4.8-4.9 4.9-1.3.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-3.3-.1-4.8-1.7-4.9-4.9C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8C2.4 3.9 3.9 2.4 7.2 2.3 8.4 2.2 8.8 2.2 12 2.2zm0 4.7a5.1 5.1 0 1 0 0 10.2 5.1 5.1 0 0 0 0-10.2zm0 8.4a3.3 3.3 0 1 1 0-6.6 3.3 3.3 0 0 1 0 6.6zm5.3-9.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
  x: "M18.2 2.3h3.4l-7.4 8.4 8.7 11.5h-6.8l-5.3-7-6.1 7H1.3l7.9-9L.9 2.3h7l4.8 6.4 5.5-6.4zm-1.2 17.9h1.9L6.9 4.2H4.9l12.1 16z",
  tiktok:
    "M16.6 2h-3.4v13.6a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9.3a6.3 6.3 0 1 0 5.4 6.3V8.7a8 8 0 0 0 4.6 1.5V6.8A4.6 4.6 0 0 1 16.6 2z",
  youtube:
    "M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4l6.2 3.6-6.2 3.6z",
  linkedin:
    "M20.4 20.5h-3.6v-5.6c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9v5.7H9.4V9h3.4v1.6c.5-.9 1.6-1.8 3.4-1.8 3.6 0 4.3 2.4 4.3 5.5v6.2zM5.3 7.4a2.1 2.1 0 1 1 0-4.2 2.1 2.1 0 0 1 0 4.2zM7.1 20.5H3.6V9h3.5v11.5z",
  snapchat:
    "M12 2c3.1 0 5.6 2.3 5.6 5.6v2.6c.4.2 1-.1 1.4-.2.6-.1 1.1.4.9.9-.2.6-1.3 1-2 1.3-.4.2-.5.5-.3 1 .8 1.8 2.3 3.2 4.1 3.7.4.1.4.6 0 .8-.7.3-1.6.5-2.3.6-.2.3-.2 1-.5 1.2-.4.2-1.3-.2-2.2 0-1.2.2-1.9 1.6-4.7 1.6s-3.5-1.4-4.7-1.6c-.9-.2-1.8.2-2.2 0-.3-.2-.3-.9-.5-1.2-.7-.1-1.6-.3-2.3-.6-.4-.2-.4-.7 0-.8 1.8-.5 3.3-1.9 4.1-3.7.2-.5.1-.8-.3-1-.7-.3-1.8-.7-2-1.3-.2-.5.3-1 .9-.9.4.1 1 .4 1.4.2V7.6C6.4 4.3 8.9 2 12 2z",
  telegram:
    "M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13 1.4 11.5c-1-.3-1-1 .2-1.5L20.6 2.8c.9-.3 1.6.2 1.3 1.5z",
  threads:
    "M17.4 11.1c-.1 0-.2-.1-.3-.1-.2-3-1.8-4.7-4.6-4.7-1.7 0-3 .7-3.9 2l1.5 1c.6-1 1.6-1.2 2.4-1.2 1 0 1.7.3 2.1.9.3.4.5 1 .6 1.7-.8-.1-1.7-.2-2.6-.1-2.6.1-4.3 1.7-4.2 3.8.1 1.1.6 2 1.5 2.6.8.5 1.8.8 2.8.7 1.4-.1 2.5-.6 3.2-1.6.6-.7.9-1.7 1-2.9.7.4 1.2.9 1.4 1.6.5 1.1.5 2.9-1 4.4-1.3 1.3-2.9 1.9-5.3 1.9-2.7 0-4.7-.9-6-2.6C4.8 17 4.2 14.8 4.1 12c.1-2.8.7-5 1.9-6.6C7.3 3.7 9.3 2.8 12 2.8s4.8.9 6.1 2.6c.7.8 1.2 1.9 1.5 3.1l1.8-.5c-.4-1.5-1-2.8-1.9-3.9C17.9 1.9 15.4.9 12 .9 8.7.9 6.1 2 4.5 4.1 3 6 2.2 8.7 2.2 12s.8 6 2.3 7.9c1.6 2.1 4.2 3.2 7.5 3.2 2.9 0 4.9-.8 6.6-2.4 2.2-2.2 2.1-4.9 1.4-6.6-.5-1.2-1.5-2.2-2.6-3zm-4.8 4.6c-1.1.1-2.3-.4-2.4-1.5 0-.8.6-1.7 2.4-1.8h.6c.7 0 1.3.1 1.9.2-.2 2.7-1.5 3-2.5 3.1z",
};

export function SocialIcon({ k, className = "h-4 w-4" }: { k: SocialKey; className?: string }) {
  if (k === "website") return <Globe className={className} aria-hidden />;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d={PATHS[k]} />
    </svg>
  );
}

/** Profile chips. Renders nothing when there are no links. */
export function SocialLinkChips({ links }: { links?: SocialLinks }) {
  const items = SOCIAL_KEYS.filter((k) => links?.[k] && /^https:\/\//.test(links[k]!));
  if (!items.length) return null;
  return (
    <section className="mt-7" aria-label="Social links">
      <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-zinc-500 uppercase">Links</h2>
      <div className="flex flex-wrap gap-2">
        {items.map((k) => (
          <a
            key={k}
            href={links![k]}
            target="_blank"
            rel="noopener noreferrer"
            title={SOCIAL_LABELS[k]}
            aria-label={`${SOCIAL_LABELS[k]}: ${socialDisplay(k, links![k]!)}`}
            className="flex max-w-full items-center gap-1.5 rounded-full border border-white/5 bg-zinc-900/70 px-3 py-1.5 text-[13px] text-zinc-300 hover:bg-white/5"
          >
            <SocialIcon k={k} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{socialDisplay(k, links![k]!)}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
