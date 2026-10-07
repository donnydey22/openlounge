import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Strict mode double-mounts effects in dev, which would churn room joins,
  // WebSocket subscriptions and LiveKit connections. Off for a smoother realtime dev experience.
  reactStrictMode: false,
  // Hide the floating dev badge so it doesn't cover the room's bottom bar.
  devIndicators: false,
  // HTML must not be cached for a year — Android WebView / CDNs were serving a stale
  // bundle where "Let's go" stayed grey until a title was typed. Static chunks stay immutable.
  // Share links: openlounge.app/@handle → public profile card with Open Graph preview
  async rewrites() {
    return [{ source: "/@:handle([A-Za-z0-9_]{1,30})", destination: "/u/:handle" }];
  },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/:path*",
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
