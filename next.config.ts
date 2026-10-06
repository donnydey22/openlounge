import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Strict mode double-mounts effects in dev, which would churn room joins,
  // WebSocket subscriptions and LiveKit connections. Off for a smoother realtime dev experience.
  reactStrictMode: false,
  // Hide the floating dev badge so it doesn't cover the room's bottom bar.
  devIndicators: false,
};

export default nextConfig;
