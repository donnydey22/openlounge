// Calls tab helpers (pure; unit-tested). Consecutive calls with the same person, direction and missed-ness fold into one row.
import type { DirectMessage } from "@/lib/types";
import { callLabel } from "@/components/calls/CallMessageRow";

export type Row = {
  key: string;
  peerId: string;
  first: DirectMessage;
  count: number;
  outgoing: boolean;
  missed: boolean;
  video: boolean;
};

/** fold runs of calls with the same person, direction and missed-ness (Telegram: "Maya (3)") */
export function foldCalls(list: DirectMessage[], meId: string): Row[] {
  const out: Row[] = [];
  for (const m of list) {
    if (!m.call) continue;
    const mine = m.fromId === meId;
    const l = callLabel(m.call, mine);
    const peerId = mine ? m.toId : m.fromId;
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.peerId === peerId &&
      prev.outgoing === l.outgoing &&
      prev.missed === l.missed &&
      prev.first.createdAt - m.createdAt < 24 * 3600_000
    ) {
      prev.count++;
      continue;
    }
    out.push({
      key: m.id,
      peerId,
      first: m,
      count: 1,
      outgoing: l.outgoing,
      missed: l.missed,
      video: !!m.call.video,
    });
  }
  return out;
}

