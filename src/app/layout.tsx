import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "@/components/AppProvider";
import { AuthGate } from "@/components/AuthGate";
import { Toasts } from "@/components/Toasts";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_COLORS, themeInitScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Open Lounge — live audio rooms",
  description: "A Clubhouse-style social audio MVP built with Next.js, WebSockets and LiveKit.",
};

export const viewport: Viewport = {
  themeColor: THEME_COLORS.dark,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        {/* Soft rounded hexagon clip — Clubhouse-style avatars (one defs for the whole app) */}
        <svg width={0} height={0} className="absolute" aria-hidden>
          <defs>
            <clipPath id="openlounge-hex" clipPathUnits="objectBoundingBox">
              <path d="M0.25,0.045 C0.28,0.02 0.32,0.01 0.36,0.01 H0.64 C0.68,0.01 0.72,0.02 0.75,0.045 L0.95,0.28 C0.975,0.32 0.99,0.36 0.99,0.41 V0.59 C0.99,0.64 0.975,0.68 0.95,0.72 L0.75,0.955 C0.72,0.98 0.68,0.99 0.64,0.99 H0.36 C0.32,0.99 0.28,0.98 0.25,0.955 L0.05,0.72 C0.025,0.68 0.01,0.64 0.01,0.59 V0.41 C0.01,0.36 0.025,0.32 0.05,0.28 Z" />
            </clipPath>
          </defs>
        </svg>
        <ThemeProvider>
          <AppProvider>
            <Toasts />
            <AuthGate>{children}</AuthGate>
          </AppProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
