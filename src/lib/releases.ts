// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.11",
  build: 23,
  file: "/downloads/openlounge-0.3.11.apk",
  size: "6.8 MB",
  sha256: "cc7562b2f93b30da0b848b13f801ad6e753e3e701ea236d3bd40e7104777be91",
} as const;

export const IOS_RELEASE = {
  version: "0.3.11",
  build: 30,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.11-b30.ipa",
  size: "8.9 MB",
  sha256: "41a86b9ea96fcf34bcaee691fc5910fc566a313ce7cc3fb37b24934ffe707680",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";
