// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.16",
  build: 31,
  file: "/downloads/openlounge-0.3.15.apk",
  size: "98.1 MB",
  sha256: "49d7eaa8fc6829b194eabab5fba918290bf72b2ce11952346607f2535762dce5",
} as const;

export const IOS_RELEASE = {
  version: "0.3.15",
  build: 34,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.15-b34.ipa",
  size: "8.9 MB",
  sha256: "fadb2c731b6ccc29724455322597dcb0f2dcb6a071571ae73e53717cd1cf3565",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";
