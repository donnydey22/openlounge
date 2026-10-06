import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "@/components/AppProvider";
import { AuthGate } from "@/components/AuthGate";
import { Toasts } from "@/components/Toasts";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_COLORS, themeInitScript } from "@/lib/theme";
import { AVATAR_PATH } from "@/lib/avatar-shape";

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
        {/* Clubhouse-style squircle clip for avatars — one defs for the whole app */}
        <svg width={0} height={0} className="absolute" aria-hidden>
          <defs>
            <clipPath id="openlounge-hex" clipPathUnits="objectBoundingBox">
              <path d={AVATAR_PATH} />
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
