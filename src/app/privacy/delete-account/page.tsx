import Link from "next/link";
import type { Metadata } from "next";
import { SUPPORT_EMAIL } from "@/lib/support";
import { LegalFooter } from "@/components/safety/LegalFooter";
import { DeleteAccountWeb } from "./DeleteAccountWeb";

// Public account-deletion page (Google Play "Data deletion" web link; Apple 5.1.1(v) in-app deletion lives in
// Settings > Delete account). Reachable signed out (/privacy/* is public in AuthGate).
export const metadata: Metadata = { title: "Delete your account — Open Lounge" };
export const dynamic = "force-static";

const H = ({ children }: { children: React.ReactNode }) => <h2 className="mt-6 mb-2 text-base font-semibold text-zinc-100">{children}</h2>;
const mail = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Delete my Open Lounge account")}&body=${encodeURIComponent(
  "Please delete my Open Lounge account.\n\nUsername (screen name): \nPhone number or email I sign in with: \n",
)}`;

export default function DeleteAccountPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-sm leading-relaxed text-zinc-300">
      <h1 className="mb-1 text-2xl font-bold text-zinc-100">Delete your Open Lounge account</h1>
      <p className="mb-4 text-zinc-500">Open Lounge · openlounge.app</p>

      <H>Delete it yourself (fastest)</H>
      <ol className="mb-3 list-decimal space-y-1 pl-5">
        <li>Open the Open Lounge app (or openlounge.app) and sign in.</li>
        <li>Go to <b>Settings</b> and scroll to <b>Account</b>.</li>
        <li>Tap <b>Delete account</b>, type DELETE, and confirm.</li>
      </ol>
      <p>Deletion happens immediately and can&apos;t be undone. You can also do it right here:</p>
      <DeleteAccountWeb />

      <H>Can&apos;t sign in? Ask us</H>
      <p>
        Email{" "}
        <a className="underline" href={mail}>
          {SUPPORT_EMAIL}
        </a>{" "}
        from the email on your account, or include your username and the phone number you sign in with. We verify that the account is yours, then delete it
        within 30 days (usually much sooner) and reply to confirm.
      </p>

      <H>What gets deleted</H>
      <ul className="mb-3 list-disc space-y-1 pl-5">
        <li>Your profile: name, username, bio, photo, interests and social links.</li>
        <li>Your sign-in methods: phone number, email, password hash, and Google or Apple sign-in links.</li>
        <li>Your sessions, push-notification tokens and notification settings.</li>
        <li>Who you follow and who follows you, your blocks, and your read markers.</li>
        <li>Your uploaded contact codes (the scrambled phone numbers used to find friends).</li>
        <li>Rooms you are hosting are ended.</li>
      </ul>

      <H>What is kept, and for how long</H>
      <ul className="mb-3 list-disc space-y-1 pl-5">
        <li>
          Direct messages you already sent stay in the other person&apos;s inbox, shown as from &ldquo;Deleted account&rdquo; with no link to you. They are removed when
          that person deletes their account.
        </li>
        <li>Reports other people filed about your content, and our record of any moderation action, are kept for safety and legal reasons.</li>
        <li>Database backups are kept for a short rolling period and then overwritten.</li>
      </ul>

      <p className="mt-6">
        More detail is in our{" "}
        <Link className="underline" href="/privacy">
          Privacy policy
        </Link>
        .
      </p>
      <LegalFooter className="mt-10 border-t border-white/5 pt-6" />
    </main>
  );
}
