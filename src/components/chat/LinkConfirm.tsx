"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, ShieldAlert, Copy, Check } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { unicodeHost, type LinkToken } from "@/lib/linkify";
import { cn } from "@/lib/utils";

const EVENT = "openlounge:link-confirm";
const REL = "noopener noreferrer nofollow ugc";

/** Clipboard with a fallback for older WebViews / insecure contexts (no Clipboard API). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Ask before leaving the app for a link someone sent (one sheet for the whole app, see LinkConfirmHost). */
export function openLinkConfirm(t: LinkToken, opts: { menu?: boolean } = {}) {
  window.dispatchEvent(new CustomEvent<{ t: LinkToken; menu: boolean }>(EVENT, { detail: { t, menu: !!opts.menu } }));
}

/**
 * Mounted once (layout). Shows where the link really goes before opening it: the site name big, the full address,
 * and any warnings (punycode / look-alike / IP / hidden user name). "Open" is a real <a target=_blank> tap, so the
 * Android app hands it to the system browser and the iPhone app to Safari; the website opens a new tab with no
 * opener and no referrer.
 */
export function LinkConfirmHost() {
  const router = useRouter();
  const [link, setLink] = useState<LinkToken | null>(null);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ t: LinkToken; menu: boolean }>).detail;
      setCopied(false);
      setMenu(d.menu);
      setLink(d.t);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const close = () => setLink(null);
  const t = link;
  const risky = !!t && t.warnings.length > 0;
  const uni = t && t.kind === "external" ? unicodeHost(t.host) : t?.host;
  const internal = t?.kind === "internal";
  const label = menu ? "Link" : t?.kind === "mailto" ? "Send an email?" : t?.kind === "tel" ? "Call this number?" : "Open this link?";
  return (
    <Sheet open={!!t} onClose={close} title={label}>
      {t && (
        <div className="space-y-4 pb-1" data-testid="link-confirm">
          <div className="rounded-2xl border border-white/5 bg-zinc-800/60 p-4">
            <div className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">{internal ? "Open Lounge" : t.kind === "external" ? "This link goes to" : "Address"}</div>
            <div className="mt-1 text-lg font-semibold [overflow-wrap:anywhere] text-zinc-50" data-testid="link-confirm-host">
              {uni}
              {uni !== t.host && <span className="ml-1 text-sm font-normal text-zinc-400">({t.host})</span>}
            </div>
            <div className="mt-2 font-mono text-[12.5px] leading-snug break-all text-zinc-400" data-testid="link-confirm-url">
              {t.href}
            </div>
          </div>
          {risky && (
            <div className="flex gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-3.5 text-sm text-red-300" role="alert" data-testid="link-confirm-warning">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="space-y-1">
                <p className="font-semibold text-red-200">Be careful — this link may not be what it seems.</p>
                {t.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
                <p className="text-red-300/80">Never enter your password or codes on a site you reached from a chat.</p>
              </div>
            </div>
          )}
          {!risky && t.kind === "external" && !menu && <p className="text-sm text-zinc-400">You&apos;re leaving Open Lounge. Only open links from people you trust.</p>}
          <div className="grid grid-cols-[auto_1fr] gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                copyText(t.href).then((ok) => ok && setCopied(true));
              }}
              className="flex h-12 items-center justify-center gap-2 rounded-full bg-zinc-800 px-4 text-sm font-semibold text-zinc-200 hover:bg-zinc-700"
              aria-label="Copy link"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              href={t.href}
              {...(t.kind === "external" ? { target: "_blank" } : null)}
              {...(internal
                ? {
                    onClick: (e: React.MouseEvent) => {
                      e.preventDefault();
                      close();
                      if (t.path) router.push(t.path);
                    },
                  }
                : null)}
              rel={REL}
              referrerPolicy="no-referrer"
              {...(!internal ? { onClick: () => setTimeout(close, 0) } : null)}
              className={cn(
                "flex h-12 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-semibold",
                risky ? "bg-red-500/90 text-white hover:bg-red-500" : "bg-emerald-500 text-on-accent hover:bg-emerald-400",
              )}
              data-testid="link-confirm-open"
            >
              <ExternalLink className="h-4 w-4" />
              {risky ? "Open anyway" : t.kind === "mailto" ? "Email" : t.kind === "tel" ? "Call" : "Open"}
            </a>
          </div>
        </div>
      )}
    </Sheet>
  );
}
