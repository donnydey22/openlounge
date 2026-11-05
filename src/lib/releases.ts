// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
export const ANDROID_RELEASE = {
  version: "0.3.28",
  build: 45,
  file: "/downloads/openlounge-0.3.28-45.apk",
  size: "25.8 MB",
  sha256: "b17ee74ae1c96fc1a310cc61cde1a5f7e2d205239a2dff89f7ada773d1f7182c",
} as const;
/** Previous Android build, kept as an unlinked rollback file (release asset stays; restore = swap these two objects). */
export const ANDROID_FALLBACK = {
  version: "0.3.26",
  build: 43,
  file: "/downloads/openlounge-0.3.26-43.apk",
  size: "24.4 MB",
  sha256: "17207e9ed1e9e11cb4586871b0fcb2b155e41bb4ee140c1189a7a4626938cf54",
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

/** ARCHIVED 2026-11-04: b91, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B91 = {
  version: "0.3.19",
  build: 91,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b91.ipa",
  size: "10.3 MB",
  sha256: "43b6485fc37801f33ae6dd9c83061c660746e10646a2c6810a6362f78c3d8cef",
} as const;

/** iOS b94 deletions (pj-openlounge-ios 619c92e); EAS remote counter assigned CFBundleVersion 95. */
/** ARCHIVED 2026-11-04: b95, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B95 = {
  version: "0.3.19",
  build: 95,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b95.ipa",
  size: "9.9 MB",
  sha256: "da1a313159f5b6a16785c0bb0c5b832e24aa0f44b02f3791531994785cb163c2",
} as const;
/** ARCHIVED 2026-11-04: b98, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B98 = {
  version: "0.3.19",
  build: 98,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b98.ipa",
  size: "10.4 MB",
  sha256: "6e6c2713f9ef49232913dae4ae63a76836a1c86fecede6650d373a9e1bda7cbe",
} as const;
/** ARCHIVED 2026-11-04: b100, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B100 = {
  version: "0.3.19",
  build: 100,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b100.ipa",
  size: "9.9 MB",
  sha256: "e8b2cc10171a9ca4eee0c9396acc5ccf7c7eb1014e2d5e6c45246ef94807c5ae",
} as const;
/** ARCHIVED 2026-11-05: b101, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B101 = {
  version: "0.3.19",
  build: 101,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b101.ipa",
  size: "9.9 MB",
  sha256: "c23dd4e2bfab9a3d164e861310d6538b78989fb37530116b7053e9e5200af1f5",
} as const;
/** ARCHIVED 2026-11-05: b104, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B104 = {
  version: "0.3.19",
  build: 104,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b104.ipa",
  size: "10.4 MB",
  sha256: "cac5d213d36a507d0e9b57549a35ae16080d3334082b9f768c5c10a61e2214a1",
} as const;
export const IOS_RELEASE = {
  version: "0.3.19",
  build: 106,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b106.ipa",
  size: "10.4 MB",
  sha256: "644abd906970e412aa745ec72caecedbc545cc2edac595ca5b911e0c0615e928",
} as const;

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";

// Binaries are hosted as GitHub release assets (a ~400 MB `railway up` upload kept failing); /downloads/*.ipa|apk redirect there.
export const BINARY_HOST = "https://github.com/donnydey22/openlounge/releases/download/downloads-v1";
export const binaryUrl = (file: string) => `${BINARY_HOST}/${file.split("/").pop()}`;
