// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.16",
  build: 32,
  file: "/downloads/openlounge-0.3.15.apk",
  size: "98.1 MB",
  sha256: "d46e12d4eec907a9967539f8021c397dcd162383566f8bf92e8db0b8deba3eda",
} as const;

export const IOS_RELEASE = {
  version: "0.3.16",
  build: 46,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.16-b46.ipa",
  size: "15.4 MB",
  sha256: "fc89e09c9e8b2f501840892f2d1e25c6efddcb7440d396adc5d8bdba05a522d9",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";
