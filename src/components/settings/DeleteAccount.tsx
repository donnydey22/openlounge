"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { DeleteAccountFlow } from "./DeleteAccountFlow";

/** Settings > Account > Delete account (App Store 5.1.1(v)): explain → re-verify → final red confirm. */
export function DeleteAccount({ onDeleted, toast }: { onDeleted: () => void; toast: (msg: string) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Account</h2>
      <div className="overflow-hidden rounded-2xl border border-white/5 bg-white/[0.03]">
        <button
          onClick={() => {
            setKey((k) => k + 1);
            setOpen(true);
          }}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-red-400 hover:bg-red-500/10"
          data-testid="settings-delete-account"
        >
          <Trash2 className="h-4 w-4" /> Delete account
        </button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title="Delete account">
        <DeleteAccountFlow
          key={key}
          onCancel={() => setOpen(false)}
          onDeleted={() => {
            setOpen(false);
            toast("Your account was deleted");
            onDeleted();
            router.push("/");
          }}
        />
      </Sheet>
    </section>
  );
}
