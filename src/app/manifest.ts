import type { MetadataRoute } from "next";
import { THEME_COLORS } from "@/lib/theme";

// Minimal web app manifest: lets people "Add to Home Screen" (required for web notifications on
// iPhone, iOS 16.4+) and gives notifications a proper app name/icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Open Lounge",
    short_name: "Open Lounge",
    description: "Live audio rooms",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME_COLORS.dark,
    theme_color: THEME_COLORS.dark,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
