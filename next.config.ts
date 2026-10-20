import type { NextConfig } from "next";

// Short git SHA for Settings "Open Lounge web · <sha>" (Railway sets RAILWAY_GIT_COMMIT_SHA at build).
const gitCommit =
  process.env.NEXT_PUBLIC_GIT_COMMIT ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  "";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommit,
  },
  // Strict mode double-mounts effects in dev, which would churn room joins,
  // WebSocket subscriptions and LiveKit connections. Off for a smoother realtime dev experience.
  reactStrictMode: false,
  // Hide the floating dev badge so it doesn't cover the room's bottom bar.
  devIndicators: false,
  poweredByHeader: false,
  compress: true, // gzip from the Node server (Railway's edge doesn't re-compress)
  // drop console.log/info/debug from the client bundle in production (warn/error stay for diagnostics)
  compiler: { removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false },
  experimental: { optimizePackageImports: ["lucide-react", "livekit-client"] },
  // HTML must not be cached for a year — Android WebView / CDNs were serving a stale
  // bundle where "Let's go" stayed grey until a title was typed. Static chunks stay immutable.
  // Share links: openlounge.app/@handle → public profile card with Open Graph preview
  async rewrites() {
    return [{ source: "/@:handle([A-Za-z0-9_]{1,30})", destination: "/u/:handle" }];
  },
  // native binaries live on GitHub release assets (see BINARY_HOST in src/lib/releases.ts)
  async redirects() {
    return [{ source: "/downloads/:file([A-Za-z0-9._-]+\\.(?:ipa|apk))", destination: "https://github.com/donnydey22/openlounge/releases/download/downloads-v1/:file", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // brand/icon assets: content changes ship with new file names only via deploys; cache a day, revalidate after
        source: "/:dir(icons|brand)/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        // animated emoji (versioned folder: a re-encode ships as /emoji/v2/…) — cache forever
        source: "/emoji/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/downloads/:file*.apk",
        headers: [
          { key: "Content-Type", value: "application/vnd.android.package-archive" },
          { key: "Content-Disposition", value: "attachment" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
      {
        source: "/downloads/:file*.ipa",
        headers: [
          { key: "Content-Type", value: "application/octet-stream" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
      {
        source: "/downloads/:file*.plist",
        headers: [
          { key: "Content-Type", value: "application/xml" },
          { key: "Cache-Control", value: "no-cache" },
        ],
      },
      {
        source: "/((?!_next/static|icons|brand|emoji/|downloads/|lp/img/|sp/img/).*)", // lp/sp images: versioned/content-keyed URLs set their own immutable caching
        headers: [
          {
            key: "Cache-Control",
            value: "private, no-cache, no-store, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
