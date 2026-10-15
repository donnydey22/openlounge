import { IOS_RELEASE } from "@/lib/releases";

export const dynamic = "force-static";

/** itms-services install manifest, generated from the single release source (src/lib/releases.ts). */
export function GET() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>https://openlounge.app${IOS_RELEASE.file}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${IOS_RELEASE.bundleId}</string>
        <key>bundle-version</key>
        <string>${IOS_RELEASE.version}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>Open Lounge</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-cache" } });
}
