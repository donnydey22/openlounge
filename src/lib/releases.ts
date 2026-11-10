// ONE source for the native builds offered on /download: the page labels AND the iOS install manifest
// (/downloads/openlounge-ios.plist route) both read this, so a version label can never drift from the file.
/** Android54: signed release 0.3.37 — 0.3.36 plus the call log (t5375): every call's six-state machine with failure tags,
 *  on-disk queue, uploaded to /api/call-log. olcall (Pion + coturn) is the only call engine. Physical-device validation pending. */
export const ANDROID_RELEASE = {
  version: "0.3.37",
  build: 54,
  file: "/downloads/openlounge-0.3.37-54.apk",
  size: "44.4 MB",
  sha256: "bda8721ff762c56c65a231a0fdb66ccf9515e4105522e064496141282adc80a7",
} as const;
/** Previous Android build (53), kept as an unlinked rollback file (stays in public/downloads; restore = swap these two objects).
 *  52 (0.3.35) also stays in public/downloads and direct-hosted. */
export const ANDROID_FALLBACK = {
  version: "0.3.36",
  build: 53,
  file: "/downloads/openlounge-0.3.36-53.apk",
  size: "44.3 MB",
  sha256: "3c0c5bbdb9b1c0d851b4ec4de746abbbfba648767b9aa4a3fc237bdc14917286",
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
/** iOS128 remains in public/downloads and direct-hosted (unlinked). */
/** Previous iOS build (130), kept as an unlinked rollback file (stays in public/downloads; restore = swap these two objects). */
export const IOS_FALLBACK = {
  version: "0.4.0",
  build: 130,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.4.0-b130.ipa",
  size: "8.9 MB",
  sha256: "441b0e0d5b4b33a589a1beca679bc8ed02fe1b4018dd59262634f8e2d196b905",
} as const;
/** iOS131: signed ad-hoc 0.4.0 (build 131) — b130 plus WKScriptMessage frame-URL fallback so nativeMedia can open /v1/call, and the t5375 six-state call-log uploader. */
export const IOS_RELEASE = {
  version: "0.4.0",
  build: 131,
  bundleId: "com.donnydey.openlounge",
  file: "/downloads/openlounge-ios-0.4.0-b131.ipa",
  size: "9.0 MB",
  sha256: "ade6d3331a8b094fd64587593df3cd57535e9cb3cc9666127c4234caf56b0559",
} as const;

export const CALLING_RELEASE_NOTICE = "Latest signed calling-update test builds. Build and signing checks passed; physical-device and normal-network audio/video calling validation are still pending. Signal-identical behavior is not verified.";

export const releaseLabel = (r: { version: string; build: number }) => `${r.version} (build ${r.build})`;
export const IOS_MANIFEST_URL = "https://openlounge.app/downloads/openlounge-ios.plist";

// Current builds are hosted directly; this host is only for archived legacy release assets.
export const BINARY_HOST = "https://github.com/donnydey22/openlounge/releases/download/downloads-v1";
export const binaryUrl = (file: string) => file === ANDROID_RELEASE.file || file === ANDROID_FALLBACK.file || file === IOS_RELEASE.file || file === IOS_FALLBACK.file ? `https://openlounge.app${file}` : `${BINARY_HOST}/${file.split("/").pop()}`;
