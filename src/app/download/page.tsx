import type { Metadata } from "next";
import { DownloadHub } from "./DownloadHub";

export const metadata: Metadata = { title: "Download — Open Lounge" };
export const dynamic = "force-static";

export default function Download() {
  return <DownloadHub />;
}
