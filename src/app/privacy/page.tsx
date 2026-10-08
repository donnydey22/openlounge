import Link from "next/link";
import type { Metadata } from "next";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { LegalFooter } from "@/components/safety/LegalFooter";

export const metadata: Metadata = {
  title: "Privacy Policy — Open Lounge",
  description: "What Open Lounge collects, why, who processes it, how long we keep it, and how to delete your account.",
};
export const dynamic = "force-static";

const H = ({ id, children }: { id?: string; children: React.ReactNode }) => (
  <h2 id={id} className="mt-8 mb-2 scroll-mt-20 text-base font-semibold text-zinc-100">
    {children}
  </h2>
);
const H3 = ({ children }: { children: React.ReactNode }) => <h3 className="mt-4 mb-1 text-sm font-semibold text-zinc-200">{children}</h3>;
const UL = ({ children }: { children: React.ReactNode }) => <ul className="mb-3 list-disc space-y-1.5 pl-5">{children}</ul>;
const A = ({ href, children }: { href: string; children: React.ReactNode }) =>
  href.startsWith("/") ? (
    <Link className="underline underline-offset-2" href={href}>
      {children}
    </Link>
  ) : (
    <a className="underline underline-offset-2" href={href}>
      {children}
    </a>
  );

export default function Privacy() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 text-sm leading-relaxed break-words text-zinc-300">
      <h1 className="mb-1 text-2xl font-bold text-zinc-100">Privacy Policy</h1>
      <p className="mb-4 text-zinc-500">Last updated October 7, 2026</p>
      <p>
        Open Lounge is a live audio and messaging app, operated by <b>Global Network LLC</b> (&ldquo;Open Lounge,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;). This policy
        explains what we collect, why, who helps us process it, how long we keep it, and your choices. It applies to the Open Lounge apps for iPhone and Android and to
        openlounge.app. Please also read our <A href="/terms">Terms of Use</A>.
      </p>

      <H id="summary">1. The short version</H>
      <UL>
        <li>We collect what&apos;s needed to run your account, rooms, messages, calls and notifications.</li>
        <li>
          <b>We don&apos;t sell your data, we don&apos;t show ads, and we don&apos;t track you</b> across other companies&apos; apps or websites.
        </li>
        <li>
          <b>Live audio and video aren&apos;t recorded.</b> They&apos;re relayed in real time and not stored.
        </li>
        <li>Finding friends from your contacts is optional. Only one-way scrambled codes (hashes) of phone numbers leave your phone. Names never do.</li>
        <li>
          You can delete your account at any time in the app (Settings &gt; Account &gt; Delete account) or at{" "}
          <A href="/privacy/delete-account">openlounge.app/privacy/delete-account</A>.
        </li>
        <li>Open Lounge is for adults 18 and older.</li>
      </UL>

      <H id="collect">2. What we collect</H>
      <H3>Information you give us</H3>
      <UL>
        <li>
          <b>Profile:</b> your name, screen name (username), profile photo, bio, interests and the social links you add. Shown to other members.
        </li>
        <li>
          <b>Phone number:</b> if you sign in with your phone. We verify it with a text-message code sent by Google Firebase. Other members never see your number.
        </li>
        <li>
          <b>Email address:</b> if you add one or sign in with an emailed code or a password, so we can sign you in and send codes and password-reset links.
        </li>
        <li>
          <b>Password:</b> if you set one. It&apos;s stored only as a salted one-way hash. We can&apos;t read it.
        </li>
        <li>
          <b>Google or Apple sign-in:</b> if you choose it, we receive an account ID and email address (with Apple&apos;s &ldquo;Hide My Email,&rdquo; only a relay address).
        </li>
        <li>
          <b>Messages and rooms:</b> direct messages (including links, reactions, stickers and room invites), room titles and in-room chat. In-room chat is discarded when the
          room ends.
        </li>
        <li>
          <b>Purchases:</b> if you buy something on openlounge.app, we keep an order record (item, price, date, status, payment type and the processor&apos;s order ID).
        </li>
        <li>
          <b>Reports and support:</b> reports you file (with your note and a copy of the reported text) and emails you send us.
        </li>
      </UL>
      <H3>Information created as you use Open Lounge</H3>
      <UL>
        <li>Who you follow, who follows you, and people you&apos;ve blocked.</li>
        <li>Rooms you host or join and your role in them (host, speaker, listener).</li>
        <li>Online status and &ldquo;last seen&rdquo; time, read receipts. &ldquo;Typing…&rdquo; indicators are relayed live and never stored.</li>
        <li>
          <b>Device information:</b> sign-in sessions (we store only a hash of each session token, plus a label such as &ldquo;android-app&rdquo; or the browser name), your
          push-notification token and your notification settings. Like every website, our servers briefly process your IP address to deliver the service,
          limit abuse and keep short-lived security logs.
        </li>
      </UL>
      <H3>Information from your device, only with your permission</H3>
      <UL>
        <li>
          <b>Microphone:</b> used only while you speak in a room, a drop-in chat or a call. Audio is streamed live and <b>is not recorded or stored</b>.
        </li>
        <li>
          <b>Camera and photos:</b> used only when you turn on video in a call (streamed live, never recorded) or choose a profile photo.
        </li>
        <li>
          <b>Contacts:</b> see <A href="#contacts">section 3</A>.
        </li>
        <li>
          <b>Notifications:</b> only if you allow them. You can change them in Settings &gt; Notifications or in your phone&apos;s settings.
        </li>
        <li>
          <b>Face ID or fingerprint</b> (app lock and quick sign-in): handled entirely by your phone. We never receive biometric data, only whether the check passed.
        </li>
      </UL>
      <p>We don&apos;t collect your location, and we don&apos;t use advertising IDs, ad networks, analytics SDKs or cross-app tracking.</p>

      <H id="contacts">3. Contacts: Find friends and &ldquo;Friends joining&rdquo; alerts</H>
      <p>
        Contacts are optional. Open Lounge reads your address book only if you open <b>Invite friends &gt; Find friends</b>, read our explanation, tap <b>Agree &amp; continue</b>
        , and allow access in your phone&apos;s prompt. If you say no, everything else works the same.
      </p>
      <UL>
        <li>
          <b>On your phone:</b> each phone number is put into international format and turned into a one-way scrambled code (a SHA-256 hash).{" "}
          <b>Only these codes are uploaded.</b> Names, emails, photos and every other field stay on your phone.
        </li>
        <li>
          <b>On our server:</b> each code is scrambled again with a secret key only our server holds (a keyed hash). Without that key, nobody, including someone who stole our
          database, could turn the codes back into phone numbers.
        </li>
        <li>
          <b>What they&apos;re used for:</b> to show which of your contacts already use Open Lounge, and, if one of your contacts joins soon after, to send you a
          &ldquo;friend joined&rdquo; notification.
        </li>
        <li>
          <b>How long we keep them:</b> codes that don&apos;t match a member are <b>deleted automatically after 24 hours</b>. All of your codes are deleted when you delete your
          account.
        </li>
        <li>
          <b>Your switches:</b> turn off &ldquo;Friends joining&rdquo; in <b>Settings &gt; Notifications</b> to stop those alerts, and turn off contacts access at any time in your
          phone&apos;s settings.
        </li>
        <li>We never sell, rent or share contact data, use it for ads, build profiles of people who aren&apos;t members, or message your contacts.</li>
      </UL>
      <p>
        More detail: <A href="/privacy/contacts">Contacts &amp; privacy</A>.
      </p>

      <H id="use">4. How we use information</H>
      <p>Only to provide and protect Open Lounge:</p>
      <UL>
        <li>signing you in and keeping your account secure;</li>
        <li>showing profiles and rooms, delivering messages, running live rooms, drop-ins and calls;</li>
        <li>sending the notifications you&apos;ve turned on;</li>
        <li>finding friends from your contacts, if you opt in;</li>
        <li>processing payments and keeping the records tax law requires;</li>
        <li>
          keeping people safe: enforcing blocks, filtering slurs, reviewing reports and suspending accounts that break our <A href="/terms">Terms</A>;
        </li>
        <li>fixing problems, preventing spam and abuse, and complying with the law.</li>
      </UL>
      <p>We don&apos;t use your data for advertising, we don&apos;t sell or &ldquo;share&rdquo; it as defined by California law, and we don&apos;t use it to train AI models.</p>

      <H id="payments">5. Payments</H>
      <p>
        Purchases on openlounge.app (for example sticker packs, or a Premium plan if we offer one) are processed by <b>PayPal</b>, including <b>Apple Pay</b> and{" "}
        <b>Google Pay</b> where available. You enter your payment details with them, not with us. <b>We never see or store your card number.</b> We receive the order
        details listed above so we can deliver what you bought, handle refunds and keep the records tax and accounting laws require. Those records stay after account deletion
        only as long as the law requires, and they&apos;re no longer linked to a profile. The processors handle your payment information under their own privacy policies.
      </p>

      <H id="sharing">6. Who processes data for us</H>
      <p>
        We don&apos;t sell your data. We share it only with these service providers, only to run Open Lounge. They&apos;re bound to protect it and can&apos;t use it for
        their own purposes.
      </p>
      <UL>
        <li>
          <b>Railway</b> (United States): hosting, database and file storage.
        </li>
        <li>
          <b>LiveKit</b>: the real-time audio and video software. We run it ourselves on Railway, so live media doesn&apos;t go to a third-party media service.
        </li>
        <li>
          <b>Google Firebase:</b> phone sign-in by text message, and push notifications (which reach Apple devices through Apple Push Notification service).
        </li>
        <li>
          <b>Google (Gmail):</b> sending sign-in codes and password-reset emails.
        </li>
        <li>
          <b>PayPal</b> (including Apple Pay and Google Pay): payments.
        </li>
        <li>
          <b>Apple or Google:</b> only if you choose to sign in with them.
        </li>
      </UL>
      <p>
        We may disclose information if the law requires it, to protect someone&apos;s safety, or as part of a merger or acquisition (this policy would keep applying to your
        data).
      </p>

      <H id="visibility">7. Who can see what</H>
      <UL>
        <li>
          <b>Other members:</b> your name, screen name, photo, bio, interests, social links, follower counts, and the rooms you&apos;re in while you&apos;re there. Anyone in a
          room hears what you say.
        </li>
        <li>
          <b>Only the people in the conversation:</b> your direct messages.
        </li>
        <li>
          <b>Never shown to other members:</b> your phone number, email, contacts, purchases and whom you&apos;ve blocked.
        </li>
      </UL>

      <H id="retention">8. How long we keep data</H>
      <UL>
        <li>Account data: until you delete your account.</li>
        <li>Direct messages: up to the most recent 1,000 messages in each conversation.</li>
        <li>In-room chat: deleted when the room ends. Live audio and video: never stored.</li>
        <li>Unmatched contact codes: 24 hours.</li>
        <li>Sign-in codes and reset links: expire within 10 to 30 minutes.</li>
        <li>Reports and moderation records: as long as needed for safety and legal reasons.</li>
        <li>Purchase records: as long as tax and accounting laws require.</li>
        <li>Backups: kept for a short rolling period, then overwritten.</li>
      </UL>

      <H id="delete">9. Deleting your account and your choices</H>
      <p>
        <b>Delete your account</b> in the app at <b>Settings &gt; Account &gt; Delete account</b>, or on the web at{" "}
        <A href="/privacy/delete-account">openlounge.app/privacy/delete-account</A>. We show what&apos;s deleted and what&apos;s kept, ask you to confirm it&apos;s you, and
        after a final confirmation the deletion is immediate. If you can&apos;t sign in, email us and we&apos;ll verify the request and delete the account within 30 days.
      </p>
      <UL>
        <li>
          <b>Erased:</b> your phone number, emails, password and Google/Apple sign-in links; every session and push token (you&apos;re signed out everywhere); your name,
          screen name, photo, bio, interests and links; follows, followers and blocks; your contact codes; your online status. Rooms you host are ended.
        </li>
        <li>
          <b>Kept:</b> messages you already sent stay in other people&apos;s chats, shown as from &ldquo;Deleted Account&rdquo;; reports and moderation records; purchase
          records the law requires, no longer linked to a profile. Your screen name becomes available to others later. Signing up again later creates a brand-new account.
        </li>
        <li>
          <b>Your rights:</b> depending on where you live (for example the EU, UK or California), you may have the right to access, correct, delete or port your data and to
          object to or restrict processing. Email us and we&apos;ll respond within 30 days. Our legal bases in the EU and UK are our contract with you, your consent (contacts,
          notifications, microphone and camera) and our legitimate interests (safety and preventing abuse). You can also complain to your data-protection authority.
        </li>
      </UL>

      <H id="security">10. Security</H>
      <p>
        We encrypt data in transit (HTTPS/TLS everywhere; live media uses encrypted WebRTC), store passwords, session tokens and contact codes only as one-way hashes, limit
        staff access and log moderator actions. No system is perfectly secure. If a breach affects you, we&apos;ll tell you as the law requires.
      </p>

      <H id="children">11. Adults only (18+)</H>
      <p>
        Open Lounge is only for people <b>18 and older</b>. We don&apos;t knowingly collect data from anyone under 18. If you believe someone under 18 has an account, email us
        and we&apos;ll delete it.
      </p>

      <H id="transfers">12. International transfers</H>
      <p>We&apos;re based in the United States and our servers are in the US. If you use Open Lounge from elsewhere, your data is transferred to and processed in the US.</p>

      <H id="changes">13. Changes</H>
      <p>If we make material changes, we&apos;ll update this page and tell you in the app before they take effect.</p>

      <H id="contact">14. Contact</H>
      <p>
        Global Network LLC, operator of Open Lounge ·{" "}
        <a className="underline underline-offset-2" href={SUPPORT_MAILTO}>
          {SUPPORT_EMAIL}
        </a>{" "}
        · <A href="https://openlounge.app">openlounge.app</A>
      </p>
      <LegalFooter className="mt-10 border-t border-white/5 pt-6" />
    </main>
  );
}
