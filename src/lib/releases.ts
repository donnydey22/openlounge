// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.19",
  build: 35,
  file: "/downloads/openlounge-0.3.19-35.apk",
  size: "98.1 MB",
  sha256: "ede67a523c5d94ab89f5344ad31934106a59bada261623d76b47e4982fa13d58",
} as const;

export const IOS_RELEASE = {
  version: "0.3.19",
  build: 52,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b52.ipa",
  size: "15.4 MB",
  sha256: "312715d5b3fa3465ef87872755e9252b3395a39c11f2cc567aa41554e65111f6",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";
