// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
/** Android61: signed 0.3.44 (versionCode 61) from ol-v2-no-drop-android, tag ol-android-61 — relay-only (tgcalls enableP2P false, TURN-only servers) and link calls that join straight to Connecting. Unit tests 170 pass. Device test plan (iOS-Android, Android-iOS, Android-Android, iOS-iOS; ring and link, both directions) not yet run. */
export const ANDROID_RELEASE = {
  version: "0.3.44",
  build: 61,
  file: "/downloads/openlounge-0.3.44-61.apk",
  size: "56.6 MB",
  sha256: "e06c149a8e678efc4ecf5b6abdc925dc9f3f2b3f6f845b1d770729c661ef3835",
  qualifier: "test",
} as const;
/** Previous Android build offered on /download: 0.3.43 (60) test. Kept as an unlinked rollback file (stays in public/downloads and direct-hosted; restore = swap these two objects).
 *  59, 58 test-logs, 57, 55, 54 call-integration, 54 call-log (openlounge-0.3.37-54.apk), 53 (0.3.36) and 52 (0.3.35) also stay in public/downloads and direct-hosted. */
export const ANDROID_FALLBACK = {
  version: "0.3.43",
  build: 60,
  file: "/downloads/openlounge-0.3.43-60.apk",
  size: "56.4 MB",
  sha256: "3066d9b065632b20a953b774af768db361e92ab896ef60a95b39c32d8bed037b",
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
/** ARCHIVED 2026-11-05: b106, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B106 = {
  version: "0.3.19",
  build: 106,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b106.ipa",
  size: "10.4 MB",
  sha256: "644abd906970e412aa745ec72caecedbc545cc2edac595ca5b911e0c0615e928",
} as const;
/** b107 combined calling fix (pj-openlounge-ios e7019a7); EAS remote counter assigned CFBundleVersion 109. */
/** ARCHIVED 2026-11-05: b109, asset kept on downloads-v1, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B109 = {
  version: "0.3.19",
  build: 109,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b109.ipa",
  size: "10.0 MB",
  sha256: "9e279b23020715b6c025808698e08e7e62c92537077195902ca60ba5c749bf73",
} as const;
/** ARCHIVED 2026-11-06: b113, asset kept on public/downloads, not linked. Rollback = set IOS_RELEASE back to these values. */
export const IOS_ARCHIVED_B113 = {
  version: "0.3.19",
  build: 113,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.3.19-b113.ipa",
  size: "10.0 MB",
  sha256: "f32f740be2661219911f852592a5103d66b34c071334d63d68d93c1cb5fbcf0b",
} as const;
/** iOS128, iOS130, both iOS131 files, iOS131 call-integration, iOS132, iOS135 and iOS136 remain in public/downloads and direct-hosted (unlinked). */
/** Previous iOS build offered on /download: 0.4.0 (137) test. Kept as an unlinked rollback file (stays in public/downloads and direct-hosted; restore = swap these two objects). */
export const IOS_FALLBACK = {
  version: "0.4.0",
  build: 137,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.4.0-b137.ipa",
  size: "8.7 MB",
  sha256: "f4a0aaa2b78b7227635e7a8304e7f6ffd4356c045728d61ea14a69a757b596ac",
} as const;
/** iOS140: signed ad-hoc 0.4.0 (build 140) from openlounge-ios ol-b140 712372d, tag ol-ios-140 — relay-only (tgcalls allowP2P false). CI 44475729648: 94 tests, 0 failures. Device test plan (iOS-Android, Android-iOS, Android-Android, iOS-iOS; ring and link, both directions) not yet run. */
export const IOS_RELEASE = {
  version: "0.4.0",
  build: 140,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.4.0-b140.ipa",
  size: "10.1 MB",
  sha256: "ca756c09fb5c8279b415cfb84ae8829f6784cd4f668f404e12d62245bacc152f",
  qualifier: "test",
} as const;

export const CALLING_RELEASE_NOTICE = "Latest signed calling-update test builds. Build and signing checks passed; physical-device and normal-network audio/video calling validation are still pending. Signal-identical behavior is not verified.";

export const releaseLabel = (r: { version: string; build: number; qualifier?: string }) => r.qualifier ? `${r.version} (build ${r.build}, ${r.qualifier})` : `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";

// Current builds are hosted directly; this host is only for archived legacy release assets.
export const BINARY_HOST = "https://github.com/donnydey22/openlounge/releases/download/downloads-v1";
export const binaryUrl = (file: string) => file === ANDROID_RELEASE.file || file === ANDROID_FALLBACK.file || file === IOS_RELEASE.file || file === IOS_FALLBACK.file ? `https://openlounge.app${file}` : `${BINARY_HOST}/${file.split("/").pop()}`;
