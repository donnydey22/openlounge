// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.12",
  build: 24,
  file: "/downloads/openlounge-0.3.12.apk",
  size: "6.8 MB",
  sha256: "c4434c227b5e2182f8527df5e546d7a04f0dd62d9b0e8b586e93c22a13c28895",
} as const;

export const IOS_RELEASE = {
  version: "0.3.12",
  build: 31,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.12-b31.ipa",
  size: "8.9 MB",
  sha256: "c74a3db8c629a8699ebd7439a57f557268d26b56aa7eb7da3f8e8c3aec2b2719",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";
