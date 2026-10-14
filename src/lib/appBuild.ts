// App build label for Settings (and anything else that needs the shell version).
// Native wrappers append ` OpenLounge/<android|ios>/<version>(<build>)` to the WebView user agent.
// Older builds used `OpenLoungeAndroid/<version>` / `OpenLoungeiOS/<version>` — both are accepted.

export type AppBuildInfo =
  | { kind: "native"; platform: "Android" | "iOS"; version: string; build: string }
  | { kind: "web"; commit: string | null };

const NEW_UA = /\bOpenLounge\/(android|ios)\/([^\s(/]+)\((\d+)\)/i;
const OLD_ANDROID = /\bOpenLoungeAndroid\/([^\s]+)/i;
const OLD_IOS = /\bOpenLoungeiOS\/([^\s]+)/i;

function bridgeVersion(): { platform: "Android" | "iOS"; version: string; build: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const b = (window as unknown as { OpenLoungeNative?: { getPlatform?: () => string; platform?: string; getVersion?: () => string; version?: string; getBuildNumber?: () => string | number; buildNumber?: string | number } }).OpenLoungeNative;
    if (!b) return null;
    const pRaw = typeof b.getPlatform === "function" ? b.getPlatform() : b.platform;
    const platform = pRaw === "android" ? "Android" : pRaw === "ios" ? "iOS" : null;
    if (!platform) return null;
    const version = (typeof b.getVersion === "function" ? b.getVersion() : b.version) || "";
    const buildRaw = typeof b.getBuildNumber === "function" ? b.getBuildNumber() : b.buildNumber;
    const build = buildRaw != null && String(buildRaw) !== "" ? String(buildRaw) : "";
    if (!version) return null;
    return { platform, version: String(version), build };
  } catch {
    return null;
  }
}

/** Parse a user-agent (or the current one) for the wrapper version stamp. */
export function parseAppBuild(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): AppBuildInfo {
  const m = NEW_UA.exec(ua);
  if (m) {
    return {
      kind: "native",
      platform: m[1].toLowerCase() === "ios" ? "iOS" : "Android",
      version: m[2],
      build: m[3],
    };
  }
  const a = OLD_ANDROID.exec(ua);
  if (a) return { kind: "native", platform: "Android", version: a[1], build: "" };
  const i = OLD_IOS.exec(ua);
  if (i) return { kind: "native", platform: "iOS", version: i[1], build: "" };

  const fromBridge = bridgeVersion();
  if (fromBridge) return { kind: "native", ...fromBridge };

  const sha = (process.env.NEXT_PUBLIC_GIT_COMMIT || "").trim();
  const short = sha ? sha.slice(0, 7) : null;
  return { kind: "web", commit: short };
}

/** One muted Settings line, e.g. `Open Lounge 0.3.6 (18) · Android` or `Open Lounge web · 48b4783`. */
export function appBuildLabel(info: AppBuildInfo = parseAppBuild()): string {
  if (info.kind === "native") {
    const build = info.build ? ` (${info.build})` : "";
    return `Open Lounge ${info.version}${build} · ${info.platform}`;
  }
  return info.commit ? `Open Lounge web · ${info.commit}` : "Open Lounge web";
}

/** True when the UA (or bridge) identifies a native Open Lounge shell. */
export function uaLooksNative(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return NEW_UA.test(ua) || OLD_ANDROID.test(ua) || OLD_IOS.test(ua);
}

export function uaNativePlatform(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): "android" | "ios" | null {
  const m = NEW_UA.exec(ua);
  if (m) return m[1].toLowerCase() === "ios" ? "ios" : "android";
  if (OLD_IOS.test(ua)) return "ios";
  if (OLD_ANDROID.test(ua)) return "android";
  return null;
}
