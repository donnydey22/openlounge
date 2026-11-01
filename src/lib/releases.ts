// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.21",
  build: 37,
  file: "/downloads/openlounge-0.3.21-37.apk",
  size: "48.3 MB",
  sha256: "dc4bcf90b96c2fee17a3bdf214515c7dd649fe10cd2bd2cba6ede4e1a009d5d6",
} as const;
/** Previous Android build, kept as an unlinked rollback file (release asset stays; restore = swap these two objects). */
export const ANDROID_FALLBACK = {
  version: "0.3.20",
  build: 36,
  file: "/downloads/openlounge-0.3.20-36.apk",
  size: "98.1 MB",
  sha256: "907ceb6fcecfa26672ee0e40b17398b568eb9cbcb0044df7c335474c7614757c",
} as const;
/** Every Android build on /download must be signed by this release certificate (SHA-256 of the signer cert), same as 0.3.19. */
export const ANDROID_SIGNER_SHA256 = "62e043661294c5e6c449f01c1cac09b5feadd916e4993dd4bc391af32a04be05";

export const IOS_RELEASE = {
  version: "0.3.19",
  build: 74,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b74.ipa",
  size: "13.9 MB",
  sha256: "597ec495ee977a72316766e7c44167016a6529aa9673503709ba018c398b5994",
} as const;
/** Previous iOS build, kept as an unlinked rollback file (release asset stays; restore = swap these two objects). */
export const IOS_FALLBACK = {
  version: "0.3.19",
  build: 73,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b73.ipa",
  size: "13.9 MB",
  sha256: "e145751ffc92cd71a04bb93de5f302704a90eb1f8d285004b66fd84795ab3526",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";

// Binaries are hosted as GitHub release assets (a ~400 MB `railway up` upload kept failing); /downloads/*.ipa|apk redirect there.
export const BINARY_HOST = "https://github.com/donnydey22/openlounge/releases/download/downloads-v1";
export const binaryUrl = (file: string) => `${BINARY_HOST}/${file.split("/").pop()}`;
