// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.10",
  build: 22,
  file: "/downloads/openlounge-0.3.10.apk",
  size: "6.8 MB",
  sha256: "15e4b4970bd2df040a40d8a5e8d93e314acdd274da020c33c77b515dfcc915b4",
} as const;

export const IOS_RELEASE = {
  version: "0.3.10",
  build: 29,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.10-b29.ipa",
  size: "8.9 MB",
  sha256: "00da743475783b2f2df3964056d965f20b90d9507355ce3837894614ab865ac2",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";
