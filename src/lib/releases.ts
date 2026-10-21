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
  build: 61,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b61.ipa",
  size: "15.4 MB",
  sha256: "f91b58db43669c9613a0de2292e907c8e4c5c18b5c913516451bddcae911421f",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";

// Binaries are hosted as GitHub release assets (a ~400 MB `railway up` upload kept failing); /downloads/*.ipa|apk redirect there.
export const BINARY_HOST = "https://github.com/donnydey22/openlounge/releases/download/downloads-v1";
export const binaryUrl = (file: string) => `${BINARY_HOST}/${file.split("/").pop()}`;
