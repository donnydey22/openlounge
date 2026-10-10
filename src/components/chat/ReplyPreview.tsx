import type { MessageReply } from "@/lib/types";

/** Small inert snapshot of the parent message, shared by DM and room-chat bubbles. */
export function ReplyPreview({ reply }: { reply: MessageReply }) {
  return (
    <div className="mb-1.5 min-w-0 border-l-2 border-current/45 pl-2 text-left leading-tight opacity-85">
      <div className="truncate text-[11px] font-semibold">{reply.authorName}</div>
      <div className="truncate text-[11px] font-normal opacity-80">{reply.text}</div>
    </div>
  );
}
