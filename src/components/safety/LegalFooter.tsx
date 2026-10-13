import Link from "next/link";
import { SUPPORT_MAILTO } from "@/lib/support";

/** Terms · Privacy · Support links (landing, legal pages, settings). */
export function LegalFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={"flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-zinc-500 " + className}>
      <Link href="/terms" className="hover:text-zinc-300 hover:underline">
        Terms of Use
      </Link>
      <Link href="/privacy" className="hover:text-zinc-300 hover:underline">
        Privacy
      </Link>
      <Link href="/privacy/delete-account" className="hover:text-zinc-300 hover:underline">
        Delete account
      </Link>
      <a href={SUPPORT_MAILTO} className="hover:text-zinc-300 hover:underline">
        Contact &amp; support
      </a>
      <span data-testid="copyright">© Global Network LLC 2026</span>
    </footer>
  );
}
