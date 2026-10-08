"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Bell, Camera, Copy, Flag, Link2, LogOut, MessageCircle, Pin, Share2, Shield, Trash2, UserPlus, Users } from "lucide-react";
import type { PublicUser } from "@/lib/types";
import { GROUP_DESCRIPTION_MAX, GROUP_TITLE_MAX, canAdmin, type GroupInvite, type GroupMember } from "@/lib/groups";
import { fileToAvatarDataUrl } from "@/lib/image";
import { friendlyMessage } from "@/lib/errors";
import { formatListTime } from "@/lib/time";
import { cn, firstName } from "@/lib/utils";
import { useApp } from "@/components/AppProvider";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/components/Sheet";
import { Switch } from "@/components/Switch";
import { ReportSheet } from "@/components/safety/ReportSheet";
import { GroupScreen, Row, Section } from "@/components/groups/GroupScreen";
import { MemberPicker } from "@/components/groups/MemberPicker";
import { memberLine, useGroupInfo } from "@/components/groups/GroupBits";

const ROLE_LABEL = { owner: "owner", admin: "admin", member: "" } as const;

/** Telegram-style group info: photo, name, description, mute, members (roles + presence), invite links, leave, report. */
export default function GroupInfoPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { request, toast, me, presenceOf } = useApp();
  const { group, gone } = useGroupInfo(id);
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [memberSheet, setMemberSheet] = useState<GroupMember | null>(null);
  const amAdmin = canAdmin(group?.myRole);
  const isOwner = group?.myRole === "owner";

  const members = useMemo(() => {
    if (!group) return [];
    const rank = { owner: 0, admin: 1, member: 2 } as const;
    const st = (m: GroupMember) => (presenceOf(m.id) === "online" ? 0 : presenceOf(m.id) === "away" ? 1 : 2);
    return [...group.members].sort((a, b) => rank[a.role] - rank[b.role] || st(a) - st(b) || a.name.localeCompare(b.name));
  }, [group, presenceOf]);

  const run = async (event: string, payload: Record<string, unknown>, done?: string) => {
    try {
      await request(event, { id, ...payload });
      if (done) toast(done);
      return true;
    } catch (e) {
      toast(friendlyMessage(e, "Something went wrong"));
      return false;
    }
  };

  const back = () => router.push(`/messages/${id}`);

  if (gone) {
    return (
      <GroupScreen title="Group" onBack={() => router.push("/messages")}>
        <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center text-zinc-400" data-testid="group-gone">
          <Users className="h-10 w-10 text-zinc-600" />
          {gone === "left" ? "You left this group." : gone === "removed" ? "You were removed from this group." : "This group doesn't exist or you're not a member."}
          <Link href="/messages" className="text-emerald-400 hover:underline">
            Back to messages
          </Link>
        </div>
      </GroupScreen>
    );
  }

  return (
    <GroupScreen
      testId="group-info"
      title="Group info"
      onBack={back}
      right={
        amAdmin && group ? (
          <button onClick={() => setEditOpen(true)} className="mr-1 rounded-full px-3 py-1.5 text-[15px] font-semibold text-emerald-400 hover:bg-emerald-500/10" data-testid="group-edit">
            Edit
          </button>
        ) : null
      }
    >
      {!group ? (
        <div className="flex flex-col items-center gap-3 pt-10" aria-hidden>
          <div className="openlounge-hex h-28 w-28 animate-pulse bg-zinc-800" />
          <div className="h-4 w-40 animate-pulse rounded-full bg-zinc-800" />
        </div>
      ) : (
        <div className="pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="flex flex-col items-center px-4 pt-6 pb-2 text-center">
            <Avatar name={group.title} color={group.color} photo={group.photoUrl} size="xl" />
            <h2 className="mt-3 max-w-full text-[22px] leading-tight font-bold [overflow-wrap:anywhere]" data-testid="group-title">
              {group.title}
            </h2>
            <p className="mt-1 text-sm text-zinc-500" data-testid="group-count">
              {memberLine(group, presenceOf)}
            </p>
            {group.description && <p className="mt-3 max-w-md text-[15px] leading-relaxed whitespace-pre-wrap text-zinc-300 [overflow-wrap:anywhere]">{group.description}</p>}
            <div className="mt-4 grid w-full max-w-sm grid-cols-3 gap-2">
              <QuickAction icon={<MessageCircle className="h-5 w-5" />} label="Message" onClick={back} />
              <QuickAction
                icon={<Bell className={cn("h-5 w-5", group.muted && "opacity-50")} />}
                label={group.muted ? "Unmute" : "Mute"}
                onClick={() => run("group:mute", { muted: !group.muted }, group.muted ? "Notifications on" : "Muted — you'll still get @mentions")}
                testId="group-mute-quick"
              />
              {amAdmin ? (
                <QuickAction icon={<UserPlus className="h-5 w-5" />} label="Add" onClick={() => setAddOpen(true)} testId="group-add-quick" />
              ) : (
                <QuickAction icon={<LogOut className="h-5 w-5" />} label="Leave" onClick={() => setLeaveOpen(true)} />
              )}
            </div>
          </div>

          <Section>
            <Row
              icon={<Bell className="h-5 w-5" />}
              label="Notifications"
              hint={group.muted ? "Muted · only @mentions" : "On"}
              right={<Switch on={!group.muted} onChange={(on) => run("group:mute", { muted: !on })} label="Notifications" />}
              testId="group-mute"
            />
            {group.pins.length > 0 && <Row icon={<Pin className="h-5 w-5" />} label="Pinned messages" hint={`${group.pins.length} pinned`} onClick={back} />}
            {amAdmin && <Row icon={<Link2 className="h-5 w-5" />} label="Invite links" hint={inviteHint(group.invites)} onClick={() => setInviteOpen(true)} testId="group-invites" />}
          </Section>

          <Section title={`${group.memberCount} members`}>
            {amAdmin && group.memberCount < group.memberLimit && (
              <Row icon={<UserPlus className="h-5 w-5 text-emerald-400" />} label={<span className="text-emerald-400">Add members</span>} onClick={() => setAddOpen(true)} testId="group-add" />
            )}
            <ul data-testid="group-members">
              {members.map((m) => {
                const st = presenceOf(m.id);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => (m.id === me?.id ? undefined : setMemberSheet(m))}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-white/5"
                      data-testid="group-member"
                      data-role={m.role}
                    >
                      <Avatar name={m.name} color={m.color} photo={m.photoUrl} size="sm" presence={st === "offline" ? null : st} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">{m.id === me?.id ? `${m.name} (you)` : m.name}</span>
                        <span className={cn("block truncate text-xs", st === "online" ? "text-emerald-400" : "text-zinc-500")}>
                          {st === "online" ? "online" : st === "away" ? "away" : `@${m.username}`}
                        </span>
                      </span>
                      {ROLE_LABEL[m.role] && <span className="shrink-0 text-xs font-medium text-zinc-500">{ROLE_LABEL[m.role]}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section>
            <Row icon={<LogOut className="h-5 w-5" />} label="Leave group" danger onClick={() => setLeaveOpen(true)} testId="group-leave" />
            <Row icon={<Flag className="h-5 w-5" />} label="Report group" danger onClick={() => setReportOpen(true)} testId="group-report" />
          </Section>
          <p className="px-4 pt-3 text-center text-xs text-zinc-600">
            Up to {group.memberLimit} members · created {formatListTime(group.createdAt)}
          </p>
        </div>
      )}

      {group && (
        <>
          <EditSheet open={editOpen} onClose={() => setEditOpen(false)} gid={id} title={group.title} description={group.description} photoUrl={group.photoUrl} color={group.color} />
          <AddMembersSheet open={addOpen} onClose={() => setAddOpen(false)} gid={id} existing={group.members} room={group.memberLimit - group.memberCount} />
          <InviteSheet open={inviteOpen} onClose={() => setInviteOpen(false)} gid={id} invites={group.invites ?? []} />
          <LeaveSheet
            open={leaveOpen}
            onClose={() => setLeaveOpen(false)}
            isOwner={isOwner}
            successor={isOwner ? successorName(group.members, me?.id) : null}
            onLeave={async () => {
              if (await run("group:leave", {})) router.replace("/messages");
            }}
          />
          <ReportSheet target={reportOpen ? { type: "group", id, label: group.title } : null} onClose={() => setReportOpen(false)} />
          <MemberSheet
            member={memberSheet}
            onClose={() => setMemberSheet(null)}
            myRole={group.myRole}
            onAction={async (action, m) => {
              setMemberSheet(null);
              if (action === "message") return router.push(`/messages/${m.id}`);
              if (action === "profile") return router.push(`/profile/${m.id}`);
              if (action === "admin") return run("group:setRole", { userId: m.id, role: "admin" }, `${firstName(m.name)} is now an admin`);
              if (action === "dismiss") return run("group:setRole", { userId: m.id, role: "member" }, `${firstName(m.name)} is no longer an admin`);
              if (action === "transfer") return run("group:transfer", { userId: m.id }, `${firstName(m.name)} is now the owner`);
              if (action === "remove") return run("group:removeMember", { userId: m.id }, `Removed ${firstName(m.name)}`);
            }}
          />
        </>
      )}
    </GroupScreen>
  );
}

function QuickAction({ icon, label, onClick, testId }: { icon: React.ReactNode; label: string; onClick: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} className="flex min-w-0 flex-col items-center gap-1 rounded-2xl bg-white/[0.05] px-1 py-2.5 text-emerald-400 hover:bg-white/[0.08]" data-testid={testId}>
      {icon}
      <span className="max-w-full truncate text-[12px] font-medium text-zinc-300">{label}</span>
    </button>
  );
}

function inviteHint(invites?: GroupInvite[]) {
  const n = invites?.length ?? 0;
  return n ? `${n} active link${n === 1 ? "" : "s"}` : "Create a link anyone can join with";
}

function successorName(members: GroupMember[], meId?: string) {
  const others = members.filter((m) => m.id !== meId);
  if (!others.length) return null;
  const admins = others.filter((m) => m.role === "admin").sort((a, b) => a.joinedAt - b.joinedAt);
  return (admins[0] ?? [...others].sort((a, b) => a.joinedAt - b.joinedAt)[0]).name;
}

type MemberAction = "message" | "profile" | "admin" | "dismiss" | "transfer" | "remove";

function MemberSheet({ member, onClose, myRole, onAction }: { member: GroupMember | null; onClose: () => void; myRole: GroupMember["role"]; onAction: (a: MemberAction, m: GroupMember) => void }) {
  const [confirm, setConfirm] = useState<MemberAction | null>(null);
  const m = member;
  const owner = myRole === "owner";
  const canRemove = !!m && m.role !== "owner" && (owner || (myRole === "admin" && m.role === "member"));
  const act = (a: MemberAction, needsConfirm = false) => {
    if (!m) return;
    if (needsConfirm && confirm !== a) return setConfirm(a);
    setConfirm(null);
    onAction(a, m);
  };
  return (
    <Sheet open={!!m} onClose={() => (setConfirm(null), onClose())} title={m?.name}>
      {m && (
        <div className="space-y-0.5" data-testid="member-sheet">
          <SheetButton icon={<MessageCircle className="h-4 w-4" />} label={`Message ${firstName(m.name)}`} onClick={() => act("message")} />
          <SheetButton icon={<Users className="h-4 w-4" />} label="View profile" onClick={() => act("profile")} />
          {owner && m.role === "member" && <SheetButton icon={<Shield className="h-4 w-4" />} label="Make admin" onClick={() => act("admin")} testId="member-make-admin" />}
          {owner && m.role === "admin" && <SheetButton icon={<Shield className="h-4 w-4" />} label="Dismiss as admin" onClick={() => act("dismiss")} />}
          {owner && (
            <SheetButton
              icon={<Shield className="h-4 w-4" />}
              label={confirm === "transfer" ? `Tap again: make ${firstName(m.name)} the owner` : "Transfer ownership"}
              onClick={() => act("transfer", true)}
              testId="member-transfer"
            />
          )}
          {canRemove && (
            <SheetButton
              icon={<Trash2 className="h-4 w-4" />}
              label={confirm === "remove" ? `Tap again to remove ${firstName(m.name)}` : "Remove from group"}
              danger
              onClick={() => act("remove", true)}
              testId="member-remove"
            />
          )}
        </div>
      )}
    </Sheet>
  );
}

function SheetButton({ icon, label, onClick, danger, testId }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium", danger ? "text-red-400 hover:bg-red-500/10" : "text-zinc-100 hover:bg-white/5")}
      data-testid={testId}
    >
      {icon} <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function LeaveSheet({ open, onClose, isOwner, successor, onLeave }: { open: boolean; onClose: () => void; isOwner: boolean; successor: string | null; onLeave: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Leave group?"
      footer={
        <div className="flex gap-2">
          <button onClick={onClose} className="h-11 flex-1 rounded-full border border-white/15 text-sm font-semibold text-zinc-200 hover:bg-white/5">
            Cancel
          </button>
          <button onClick={onLeave} className="h-11 flex-1 rounded-full bg-red-500 text-sm font-semibold text-white hover:bg-red-400" data-testid="group-leave-confirm">
            Leave
          </button>
        </div>
      }
    >
      <p className="text-sm text-zinc-400">
        {isOwner && successor
          ? `You're the owner. ${successor} will become the owner when you leave (or transfer ownership to someone else first from the member list).`
          : isOwner
            ? "You're the last member — the group will be closed."
            : "You won't get messages from this group anymore. An admin or an invite link can add you back."}
      </p>
    </Sheet>
  );
}

function EditSheet({ open, onClose, gid, title, description, photoUrl, color }: { open: boolean; onClose: () => void; gid: string; title: string; description: string; photoUrl: string | null; color: string }) {
  const { request, toast } = useApp();
  const [t, setT] = useState(title);
  const [d, setD] = useState(description);
  const [photo, setPhoto] = useState<string | null | undefined>(undefined); // undefined = unchanged, null = remove
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setT(title);
    setD(description);
    setPhoto(undefined);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!t.trim() || busy) return;
    setBusy(true);
    try {
      const patch: Record<string, unknown> = { id: gid };
      if (t.trim() !== title) patch.title = t.trim();
      if (d.trim() !== description) patch.description = d.trim();
      if (photo !== undefined) patch.photo = photo ?? "";
      if (Object.keys(patch).length > 1) await request("group:update", patch);
      onClose();
    } catch (e) {
      toast(friendlyMessage(e, "Couldn't save"));
    } finally {
      setBusy(false);
    }
  };
  const shown = photo === undefined ? photoUrl : photo;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit group"
      footer={
        <button onClick={save} disabled={!t.trim() || busy} className="h-11 w-full rounded-full bg-emerald-500 text-sm font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40" data-testid="group-save">
          Save
        </button>
      }
    >
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => fileRef.current?.click()} className="relative shrink-0" aria-label="Change group photo">
          <Avatar name={t || title} color={color} photo={shown} size="lg" />
          <span className="absolute -right-1 -bottom-1 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-on-accent ring-2 ring-zinc-900">
            <Camera className="h-3.5 w-3.5" />
          </span>
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
        <div className="min-w-0 flex-1">
          <input
            value={t}
            maxLength={GROUP_TITLE_MAX}
            onChange={(e) => setT(e.target.value)}
            placeholder="Group name"
            className="w-full border-b-2 border-emerald-500/60 bg-transparent py-2 text-base outline-none focus:border-emerald-400"
            data-testid="group-edit-title"
          />
          {shown && (
            <button type="button" onClick={() => setPhoto(null)} className="mt-2 text-xs font-medium text-red-400 hover:underline">
              Remove photo
            </button>
          )}
        </div>
      </div>
      <textarea
        value={d}
        maxLength={GROUP_DESCRIPTION_MAX}
        onChange={(e) => setD(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        className="mt-4 block w-full resize-none rounded-2xl border border-white/10 bg-zinc-950 px-4 py-2.5 text-base outline-none placeholder:text-zinc-600 focus:border-emerald-500/60 sm:text-[15px]"
      />
    </Sheet>
  );
}

function AddMembersSheet({ open, onClose, gid, existing, room }: { open: boolean; onClose: () => void; gid: string; existing: GroupMember[]; room: number }) {
  const { request, toast } = useApp();
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  const exclude = useMemo(() => new Set(existing.map((m) => m.id)), [existing]);
  const add = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      const r = await request<{ added: string[]; refused: { id: string; error: string }[] }>("group:addMembers", { id: gid, userIds: picked.map((u) => u.id) });
      toast(r.refused?.length ? `Added ${r.added.length} · ${r.refused.length} couldn't be added` : `Added ${r.added.length}`);
      setPicked([]);
      onClose();
    } catch (e) {
      toast(friendlyMessage(e, "Couldn't add those people"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add members"
      footer={
        <button onClick={add} disabled={!picked.length || busy} className="h-11 w-full rounded-full bg-emerald-500 text-sm font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-40" data-testid="group-add-confirm">
          {picked.length ? `Add ${picked.length}` : "Add"}
        </button>
      }
    >
      {open && (
        <div className="-mx-4 max-h-[55vh] overflow-y-auto">
          <MemberPicker selected={picked} onChange={setPicked} excludeIds={exclude} max={Math.max(0, room)} />
        </div>
      )}
    </Sheet>
  );
}

const EXPIRY = [
  { label: "1 hour", sec: 3600 },
  { label: "1 day", sec: 86400 },
  { label: "7 days", sec: 7 * 86400 },
  { label: "Never", sec: 0 },
];
const LIMITS = [0, 1, 10, 50, 100];

function InviteSheet({ open, onClose, gid, invites }: { open: boolean; onClose: () => void; gid: string; invites: GroupInvite[] }) {
  const { request, toast } = useApp();
  const [expiry, setExpiry] = useState(86400);
  const [limit, setLimit] = useState(0);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await request<{ invite: GroupInvite }>("group:inviteCreate", { id: gid, expiresInSec: expiry || undefined, maxUses: limit || undefined });
      await copy(r.invite.url, toast);
    } catch (e) {
      toast(friendlyMessage(e, "Couldn't create a link"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Invite links">
      <div data-testid="invite-sheet">
        <p className="text-sm text-zinc-400">Anyone with a link can preview the group and join. Revoke a link to turn it off.</p>
        <div className="mt-4">
          <div className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Expires</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {EXPIRY.map((x) => (
              <Chip key={x.sec} on={expiry === x.sec} onClick={() => setExpiry(x.sec)}>
                {x.label}
              </Chip>
            ))}
          </div>
          <div className="mt-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Member limit</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {LIMITS.map((n) => (
              <Chip key={n} on={limit === n} onClick={() => setLimit(n)}>
                {n ? `${n}` : "No limit"}
              </Chip>
            ))}
          </div>
          <button onClick={create} disabled={busy} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-emerald-500 text-sm font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-50" data-testid="invite-create">
            <Link2 className="h-4 w-4" /> Create link
          </button>
        </div>
        {invites.length > 0 && (
          <ul className="mt-5 space-y-2" data-testid="invite-list">
            {invites.map((inv) => (
              <li key={inv.token} className="rounded-2xl border border-white/10 p-3" data-testid="invite-item">
                <div className="truncate font-mono text-[13px] text-zinc-200">{inv.url.replace(/^https?:\/\//, "")}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {inv.uses} joined{inv.maxUses ? ` of ${inv.maxUses}` : ""} · {inv.expiresAt ? `expires ${expiresLabel(inv.expiresAt)}` : "never expires"}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <SmallBtn onClick={() => copy(inv.url, toast)} icon={<Copy className="h-3.5 w-3.5" />} label="Copy" />
                  {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
                    <SmallBtn onClick={() => navigator.share({ url: inv.url, title: "Join my group on Open Lounge" }).catch(() => {})} icon={<Share2 className="h-3.5 w-3.5" />} label="Share" />
                  )}
                  <SmallBtn
                    danger
                    onClick={() =>
                      request("group:inviteRevoke", { id: gid, token: inv.token })
                        .then(() => toast("Link revoked"))
                        .catch((e: Error) => toast(friendlyMessage(e, "Couldn't revoke")))
                    }
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    label="Revoke"
                    testId="invite-revoke"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

async function copy(url: string, toast: (m: string) => void) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
      return;
    }
  } catch {
    /* fall through */
  }
  // old WebViews: legacy copy via a temporary field
  const ta = document.createElement("textarea");
  ta.value = url;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  toast(ok ? "Link copied" : url);
}

/** "Oct 9, 10:02 PM" (device locale + timezone) */
function expiresLabel(ts: number) {
  try {
    return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={cn("rounded-full px-3 py-1.5 text-sm font-medium transition-colors", on ? "bg-emerald-500 text-on-accent" : "bg-white/[0.06] text-zinc-300 hover:bg-white/10")}>
      {children}
    </button>
  );
}

function SmallBtn({ onClick, icon, label, danger, testId }: { onClick: () => void; icon: React.ReactNode; label: string; danger?: boolean; testId?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", danger ? "text-red-400 hover:bg-red-500/10" : "bg-white/[0.06] text-zinc-200 hover:bg-white/10")} data-testid={testId}>
      {icon} {label}
    </button>
  );
}
