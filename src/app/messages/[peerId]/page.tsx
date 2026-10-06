"use client";

import { useParams, useRouter } from "next/navigation";
import { DmThread } from "@/components/chat/DmThread";

export default function ConversationPage() {
  const { peerId } = useParams<{ peerId: string }>();
  const router = useRouter();
  return <DmThread peerId={peerId} onBack={() => router.push("/messages")} className="mx-auto h-dvh max-w-2xl" />;
}
