"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** /profile → your own profile (signed in) or home. */
export default function MyProfileAlias() {
  const router = useRouter();
  useEffect(() => {
    let uid: string | null = null;
    try { uid = localStorage.getItem("openlounge:uid"); } catch {}
    router.replace(uid ? `/profile/${encodeURIComponent(uid)}` : "/");
  }, [router]);
  return <main className="min-h-[100dvh]" style={{ background: "rgb(11,11,13)" }} />;
}
