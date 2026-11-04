// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.22",
  build: 38,
  file: "/downloads/openlounge-0.3.22-38.apk",
  size: "25.6 MB",
  sha256: "77a074b469b868442817bba483f6352ef9278bd9ddc533e41e6fe82af7d65d9f",
} as const;
/** Previous Android build, kept as an unlinked rollback file (release asset stays; restore = swap these two objects). */
export const ANDROID_FALLBACK = {
  version: "0.3.21",
  build: 37,
  file: "/downloads/openlounge-0.3.21-37.apk",
  size: "48.3 MB",
  sha256: "dc4bcf90b96c2fee17a3bdf214515c7dd649fe10cd2bd2cba6ede4e1a009d5d6",
} as const;
export const ANDROID_SIGNER_SHA256 = "62e043661294c5e6c449f01c1cac09b5feadd916e4993dd4bc391af32a04be05";

/** ARCHIVED 2026-11-02: b88 removed from /download (no iOS fallback). Asset kept on downloads-v1. Not linked anywhere. */
export const IOS_ARCHIVED_B88 = {
  version: "0.3.19",
  build: 88,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b88.ipa",
  size: "14.0 MB",
  sha256: "397ba9f02b5ae11f236a00bcf1b7ffc72c815cac8b73b440b88d6db78a3ae596",
} as const;
/** ARCHIVED: b85, asset kept on downloads-v1, not linked. */
export const IOS_ARCHIVED_B85 = {
  version: "0.3.19",
  build: 85,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b85.ipa",
  size: "14.0 MB",
  sha256: "9dc2c109f105ed3a4cc691bbcba609f4b791f6fa14231a380f3eddba905bd2a7",
} as const;

/** No installable iOS build is offered until the PJSIP rebuild passes. Restore = set this back to IOS_ARCHIVED_B88 and restore the plist route. */
export const IOS_RELEASE: null = null;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";

// Binaries are hosted as GitHub release assets (a ~400 MB `railway up` upload kept failing); /downloads/*.ipa|apk redirect there.
export const BINARY_HOST = "https://github.com/donnydey22/openlounge/releases/download/downloads-v1";
export const binaryUrl = (file: string) => `${BINARY_HOST}/${file.split("/").pop()}`;
