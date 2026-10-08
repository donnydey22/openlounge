"use client";
// The one place the client renders a deleted member (store compliance, Telegram-style deletion).
// The server already sends deleted members as { name: "Deleted Account", deleted: true, photoUrl: null };
// this module also flips people live when `user:deleted` arrives over the WebSocket, so open screens update
// without a refetch. Use displayUser(u) (or useDisplayUser) wherever a PublicUser is rendered, and
// <Avatar deleted /> / isDeletedName(name) for message authors that only carry a name.
import { useSyncExternalStore } from "react";
import type { PublicUser } from "./types";

export const DELETED_NAME = "Deleted Account";
export const DELETED_COLOR = "#64748B";
export const DELETED_PROFILE_TEXT = "This account was deleted";
export const DELETED_COMPOSER_TEXT = "You can't message a deleted account";

let deleted = new Set<string>();
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/** called from AppProvider on `user:deleted` */
export function markDeleted(userId: string) {
  if (!userId || deleted.has(userId)) return;
  deleted = new Set(deleted).add(userId);
  subs.forEach((f) => f());
}

export const isDeletedId = (id: string | null | undefined) => !!id && deleted.has(id);
export const isDeletedName = (name: string | null | undefined) => name === DELETED_NAME;
export const isDeletedUser = (u: { id?: string; deleted?: boolean } | null | undefined) => !!u && (!!u.deleted || isDeletedId(u.id));

/** a PublicUser as it should render: the deleted ghost if they deleted their account */
export function displayUser<T extends PublicUser>(u: T): T;
export function displayUser<T extends PublicUser>(u: T | null | undefined): T | null | undefined;
export function displayUser<T extends PublicUser>(u: T | null | undefined) {
  if (!u || !isDeletedUser(u)) return u;
  return { ...u, name: DELETED_NAME, username: "", color: DELETED_COLOR, photoUrl: null, bio: "", interests: [], socialLinks: {}, deleted: true, online: false, presence: undefined, lastSeenAt: null };
}

/** re-renders when anyone is deleted live */
export function useDeletedIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => deleted, () => deleted);
}

export function useDisplayUser<T extends PublicUser>(u: T | null | undefined) {
  useDeletedIds();
  return displayUser(u);
}
