// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.14",
  build: 25,
  file: "/downloads/openlounge-0.3.14.apk",
  size: "6.8 MB",
  sha256: "a47d80ff8be32cc854596b44eba703f5ba324a7407f5be5ba3e080ca86979a19",
} as const;

export const IOS_RELEASE = {
  version: "0.3.14",
  build: 33,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.14-b33.ipa",
  size: "8.9 MB",
  sha256: "a298913b46e4f7e0535d058a1c1b3f468098a67d068c40cc46dc9af8ffdd71af",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";
