import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        source: "/((?!_next/static|icons|brand).*)",
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
