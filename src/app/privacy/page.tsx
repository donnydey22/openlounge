import Link from "next/link";
import type { Metadata } from "next";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { LegalFooter } from "@/components/safety/LegalFooter";

export const metadata: Metadata = { title: "Privacy policy — Open Lounge" };
export const dynamic = "force-static";

const H = ({ children }: { children: React.ReactNode }) => <h2 className="mt-6 mb-2 text-base font-semibold text-zinc-100">{children}</h2>;

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-sm leading-relaxed text-zinc-300">
      <h1 className="mb-1 text-2xl font-bold text-zinc-100">Privacy policy</h1>
      <p className="mb-4 text-zinc-500">Last updated October 6, 2026</p>
      <p>
        Open Lounge (openlounge.app) is a live audio and messaging app. This page explains what we collect, why, and the choices you have.
      </p>
      <H>What we collect</H>
      <ul className="mb-3 list-disc space-y-1 pl-5">
        <li>Account details: your name, username, bio, profile photo, interests and the social links you choose to add.</li>
        <li>Sign-in details: your phone number (verified by SMS through Google Firebase), and if you use them, your email address or the account identifier and email that Google or Apple share when you sign in with them. Passwords are stored only as salted hashes.</li>
        <li>Activity: who you follow, rooms you host or join, and direct messages you send.</li>
        <li>Device data: push-notification tokens and your notification settings.</li>
        <li>Contacts (optional, opt-in only): one-way hashes of phone numbers, used to find friends already on Open Lounge. Unmatched hashes are deleted within 24 hours. See <Link className="underline" href="/privacy/contacts">Contacts &amp; privacy</Link>.</li>
      </ul>
      <p>Room audio is relayed in real time through LiveKit and is not recorded by Open Lounge.</p>
      <p className="mt-2">Safety: when you report an account, room or message we store the report, your note and a copy of the reported text so our team can review it. Accounts you block are stored so we can enforce the block.</p>
      <H>How we use it</H>
      <p>Only to run the service: signing you in, showing your profile, delivering messages and notifications, keeping the service secure and preventing abuse. We do not sell your data or use it for advertising.</p>
      <H>Who processes it</H>
      <p>Railway (hosting and database), Google Firebase (phone verification and push notifications), LiveKit (real-time audio), and Google or Apple only if you choose to sign in with them.</p>
      <H>Your choices</H>
      <ul className="mb-3 list-disc space-y-1 pl-5">
        <li>Edit your profile or remove your photo, links and contacts at any time in Settings.</li>
        <li>Delete your account in Settings &gt; Delete account. This removes your profile, sign-in methods, sessions, follows, device tokens, notification settings and contact hashes. Messages you sent remain with their recipients but are shown as from &ldquo;Deleted account&rdquo;.</li>
      </ul>
      <H>Retention</H>
      <p>We keep your data while your account exists and delete it when you delete your account. Database backups are kept for a short rolling period and then overwritten.</p>
      <H>Children</H>
      <p>Open Lounge is not intended for children under 13.</p>
      <H>Contact</H>
      <p>
        Questions or requests: email{" "}
        <a className="underline" href={SUPPORT_MAILTO}>
          {SUPPORT_EMAIL}
        </a>
        . Use of Open Lounge is also subject to our{" "}
        <Link className="underline" href="/terms">
          Terms of Use
        </Link>
        .
      </p>
      <LegalFooter className="mt-10 border-t border-white/5 pt-6" />
    </main>
  );
}
