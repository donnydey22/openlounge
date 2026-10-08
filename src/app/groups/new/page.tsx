"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2 } from "lucide-react";
import type { PublicUser } from "@/lib/types";
import { GROUP_DESCRIPTION_MAX, GROUP_MAX_MEMBERS, GROUP_TITLE_MAX, type GroupInfo } from "@/lib/groups";
import { fileToAvatarDataUrl } from "@/lib/image";
import { friendlyMessage } from "@/lib/errors";
import { useApp } from "@/components/AppProvider";
import { Avatar } from "@/components/Avatar";
import { GroupScreen } from "@/components/groups/GroupScreen";
import { MemberPicker } from "@/components/groups/MemberPicker";

/** Telegram-style new group: 1) pick members  2) name, photo, description → Create → the new chat. */
export default function NewGroupPage() {
  const router = useRouter();
  const { request, toast } = useApp();
  const [step, setStep] = useState<1 | 2>(1);
  const [members, setMembers] = useState<PublicUser[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await request<{ group: GroupInfo; refused?: { id: string; error: string }[] }>("group:create", {
        title: title.trim(),
        description: description.trim() || undefined,
        photo: photo ?? undefined,
        memberIds: members.map((m) => m.id),
      });
      if (r.refused?.length) toast(`${r.refused.length} ${r.refused.length === 1 ? "person" : "people"} couldn't be added`);
      router.replace(`/messages/${r.group.id}`);
    } catch (e) {
      setError(friendlyMessage(e, "Couldn't create the group. Try again."));
      setBusy(false);
    }
  };

  if (step === 1)
    return (
      <GroupScreen
        testId="group-new-members"
        title={
          <span className="flex items-baseline gap-2">
            New group
            <span className="text-xs font-normal text-zinc-500">
              {members.length}/{GROUP_MAX_MEMBERS - 1}
            </span>
          </span>
        }
        onBack={() => router.back()}
        right={
          <button onClick={() => setStep(2)} className="mr-1 rounded-full px-3 py-1.5 text-[15px] font-semibold text-emerald-400 hover:bg-emerald-500/10" data-testid="group-next">
            {members.length ? "Next" : "Skip"}
          </button>
        }
      >
        <MemberPicker selected={members} onChange={setMembers} max={GROUP_MAX_MEMBERS - 1} />
      </GroupScreen>
    );

  return (
    <GroupScreen
      testId="group-new-details"
      title="New group"
      onBack={() => setStep(1)}
      footer={
        <button
          onClick={create}
          disabled={!title.trim() || busy}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-emerald-500 text-[15px] font-semibold text-on-accent transition hover:bg-emerald-400 disabled:opacity-40"
          data-testid="group-create"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create group
        </button>
      }
    >
      <div className="flex items-center gap-4 px-4 pt-5">
        <button type="button" onClick={() => fileRef.current?.click()} className="relative shrink-0 rounded-full" aria-label="Set group photo" data-testid="group-photo-pick">
          {photo ? (
            <Avatar name={title || "Group"} color="#10B981" photo={photo} size="lg" />
          ) : (
            <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
              <Camera className="h-7 w-7" />
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              setPhoto(await fileToAvatarDataUrl(f, 512, 0.85));
            } catch (err) {
              toast((err as Error).message || "Couldn't read that image");
            }
          }}
        />
        <label className="min-w-0 flex-1">
          <span className="sr-only">Group name</span>
          <input
            autoFocus
            value={title}
            maxLength={GROUP_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Group name"
            className="w-full border-b-2 border-emerald-500/60 bg-transparent py-2 text-base outline-none placeholder:text-zinc-600 focus:border-emerald-400 sm:text-[17px]"
            data-testid="group-title-input"
          />
        </label>
      </div>
      <div className="px-4 pt-5">
        <textarea
          value={description}
          maxLength={GROUP_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={2}
          className="block w-full resize-none rounded-2xl border border-white/10 bg-zinc-950 px-4 py-2.5 text-base outline-none placeholder:text-zinc-600 focus:border-emerald-500/60 sm:text-[15px]"
        />
      </div>
      {error && <p className="px-4 pt-3 text-sm text-red-400">{error}</p>}
      <h2 className="px-4 pt-6 pb-2 text-[12px] font-semibold tracking-wide text-emerald-400 uppercase">
        {members.length ? `${members.length + 1} members` : "Just you for now — add people later or share an invite link"}
      </h2>
      <ul className="pb-6">
        {members.map((u) => (
          <li key={u.id} className="flex items-center gap-3 px-4 py-2">
            <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" />
            <span className="min-w-0 flex-1 truncate text-[15px]">{u.name}</span>
          </li>
        ))}
      </ul>
    </GroupScreen>
  );
}
