// Browser support floor: the last 2 major versions of Chrome, Edge, Firefox and Safari (as of Oct 14, 2026:
// Chrome/Edge 155 → floor 154, Firefox 158 → floor 157, Safari 27 → floor 26). Raise these with each release.
// Detection is by ENGINE version, not brand: every iOS browser is WebKit (judged by the iOS version, which Safari
// tracks since 26), every Chromium browser (Chrome, Edge, Samsung Internet, Opera, Android WebView) by its Chrome/NN
// token, Gecko by Firefox/NN. The Open Lounge wrapper apps are never gated. Unknown engines are let through.

export const BROWSER_FLOOR = { chromium: 154, firefox: 157, webkit: 26 } as const;
/** Same floor for build targets (package.json "browserslist" must match; asserted in tests). */
export const BROWSERSLIST_FLOOR = ["chrome >= 154", "and_chr >= 154", "edge >= 154", "firefox >= 157", "safari >= 26", "ios_saf >= 26"];

export type EngineInfo = { engine: "chromium" | "firefox" | "webkit" | "unknown"; version: number | null; ios: boolean; wrapper: boolean };

export function isWrapperUA(ua: string): boolean {
  return /OpenLounge\//.test(ua) || /OpenLounge(Android|iOS)/i.test(ua);
}

export function detectEngine(ua: string): EngineInfo {
  const wrapper = isWrapperUA(ua);
  const ios = /\b(iPhone|iPad|iPod)\b/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const num = (m: RegExpExecArray | null) => (m ? parseInt(m[1], 10) : null);
  if (ios) {
    // iOS: all browsers are WebKit; prefer Safari's Version/NN, else the OS version (iOS 26 ships Safari 26).
    const v = num(/Version\/(\d+)/.exec(ua)) ?? num(/OS (\d+)[_.]\d/.exec(ua));
    return { engine: "webkit", version: v, ios, wrapper };
  }
  const ff = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua);
  if (ff && !/Seamonkey/i.test(ua)) return { engine: "firefox", version: num(ff), ios, wrapper };
  const cr = /(?:Chrome|Chromium|CriOS|HeadlessChrome)\/(\d+)/.exec(ua);
  if (cr) return { engine: "chromium", version: num(cr), ios, wrapper };
  if (/AppleWebKit\//.test(ua) && /Safari\//.test(ua)) return { engine: "webkit", version: num(/Version\/(\d+)/.exec(ua)), ios, wrapper };
  return { engine: "unknown", version: null, ios, wrapper };
}

/** true = show the unsupported page. Wrappers, unknown engines and unparseable versions are allowed. */
export function belowFloor(ua: string | null | undefined): boolean {
  if (!ua) return false;
  const e = detectEngine(ua);
  if (e.wrapper || e.engine === "unknown" || e.version == null) return false;
  return e.version < BROWSER_FLOOR[e.engine];
}

/** Paths that stay reachable for every browser: downloads, legal, APIs, assets, health. */
export function gateExempt(path: string): boolean {
  return /^\/(download|android|terms|privacy|privacy-policy|terms-of-service|api|auth|_next|avatars|media|emoji|stickers\/assets|healthz|readyz|metrics|ws|favicon\.ico|icon\.svg|apple-icon\.png|manifest\.webmanifest|robots\.txt|sitemap\.xml|\.well-known)(\/|$|\?|\.)/.test(path) || (/\.[a-z0-9]{2,5}$/i.test(path) && !/\.html?$/i.test(path));
}

export const UPDATE_LINKS = {
  chrome: "https://www.google.com/chrome/",
  firefox: "https://www.mozilla.org/firefox/new/",
  safariMac: "https://support.apple.com/en-us/108382",
  safariIOS: "https://support.apple.com/en-us/118575",
  edge: "https://www.microsoft.com/edge/download",
} as const;

/** Self-contained page (no JS, no app bundle) so it renders on any old browser. */
export function unsupportedPageHtml(ua = ""): string {
  const ios = detectEngine(ua).ios;
  const links: [string, string][] = [["Chrome", UPDATE_LINKS.chrome], ["Firefox", UPDATE_LINKS.firefox], ["Safari", ios ? UPDATE_LINKS.safariIOS : UPDATE_LINKS.safariMac], ["Edge", UPDATE_LINKS.edge]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Browser not supported · Open Lounge</title>
<style>html,body{margin:0;height:100%;background:#0b0b0f;color:#f4f4f5;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:30rem;margin:0 auto;padding:22vh 24px 40px}h1{font-size:1.375rem;font-weight:600;letter-spacing:-.01em;margin:0 0 .5rem}p{margin:0;color:#a1a1aa}nav{margin-top:1.75rem;font-size:.875rem}nav a{color:#34d399;text-decoration:none;margin-right:1.25rem;white-space:nowrap}nav a:hover{text-decoration:underline}</style></head>
<body><main data-testid="unsupported-browser"><h1>Your browser isn't supported.</h1><p>Open Lounge needs a current version of Chrome, Firefox, Safari, or Edge.</p><p>Update it from your browser's settings or download page, then reload.</p>
<nav>${links.map(([n, h]) => `<a href="${h}" rel="noopener noreferrer" target="_blank">${n}</a>`).join("")}</nav></main></body></html>`;
}

export const SUPPORTED_NOTE_KEY = "openlounge:browser-supported-note";
/** First visit only, supported engines only, never in the wrapper apps. */
export function shouldShowSupportedNote(ua: string, store: Pick<Storage, "getItem"> | null): boolean {
  if (!ua || !store || isWrapperUA(ua)) return false;
  if (store.getItem(SUPPORTED_NOTE_KEY)) return false;
  const e = detectEngine(ua);
  return e.engine !== "unknown" && e.version != null && !belowFloor(ua);
}

/** A top-level page load. Safari/WebDriver and some navigations send Accept: *\/* (or none), so also trust Sec-Fetch-*. */
export function isPageNavigation(method: string | undefined, h: Record<string, string | string[] | undefined>): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const accept = String(h.accept ?? "").trim();
  const dest = String(h["sec-fetch-dest"] ?? ""), mode = String(h["sec-fetch-mode"] ?? "");
  if (dest && dest !== "document") return false;
  if (h.rsc || h["next-router-prefetch"]) return false;
  return /text\/html/.test(accept) || dest === "document" || mode === "navigate" || accept === "" || accept === "*/*";
}
