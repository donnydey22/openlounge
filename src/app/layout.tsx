import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "@/components/AppProvider";
import { AuthGate } from "@/components/AuthGate";
import { Toasts } from "@/components/Toasts";
import { Notifier } from "@/components/Notifier";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_COLORS, themeInitScript } from "@/lib/theme";
import { AVATAR_PATH } from "@/lib/avatar-shape";
import { AppShell } from "@/components/AppShell";
import { LinkConfirmHost } from "@/components/chat/LinkConfirm";
import { ChatSearchHost } from "@/components/search/ChatSearch";
import { MonetBoot } from "@/components/premium/MonetBoot";
import { BrowserSupportedNote } from "@/components/BrowserSupportedNote";
import { legacyPolyfills } from "@/lib/legacyPolyfills";
import { CallProvider } from "@/components/calls/CallProvider";
import { LiveRoomProvider } from "@/components/room/LiveRoomProvider";

// Inside the Android/iPhone apps the page is an app screen: no pinch/double-tap zoom (which pans the whole UI).
// The public website keeps zoom for accessibility; fields are 16px on touch devices so focus never zooms anyway.
const appViewportScript = `try{if(/OpenLounge(\\/(android|ios)\\/|iOS|Android|Expo)/.test(navigator.userAgent)){document.documentElement.setAttribute('data-native-app','');var f=function(){var m=document.querySelector('meta[name=viewport]');if(!m)return false;if(m.content.indexOf('maximum-scale')<0)m.content+=', maximum-scale=1, user-scalable=no';return true};if(!f())document.addEventListener('DOMContentLoaded',f)}}catch(e){}`;

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_PUBLIC_ORIGIN || "https://openlounge.app"),
  title: "Open Lounge — live audio rooms",
  description: "A Clubhouse-style social audio MVP built with Next.js, WebSockets and LiveKit.",
  applicationName: "Open Lounge",
  // iPhone: "Add to Home Screen" opens as an app (needed for web notifications on iOS 16.4+)
  appleWebApp: { capable: true, title: "Open Lounge", statusBarStyle: "default" },
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
        {/* first: runtime polyfills for old Android WebViews (Chrome 69+), before any bundle runs */}
        <script dangerouslySetInnerHTML={{ __html: legacyPolyfills }} />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: appViewportScript }} />
      </head>
      <body className="font-sans antialiased">
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
            <Notifier>
              <Toasts />
              <BrowserSupportedNote />
              <LinkConfirmHost />
              <ChatSearchHost />
              <MonetBoot />
              <LiveRoomProvider>
                <CallProvider>
                  <AppShell>
                    <AuthGate>{children}</AuthGate>
                  </AppShell>
                </CallProvider>
              </LiveRoomProvider>
            </Notifier>
          </AppProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
