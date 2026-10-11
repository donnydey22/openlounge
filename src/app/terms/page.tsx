import Link from "next/link";
import type { Metadata } from "next";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { LegalFooter } from "@/components/safety/LegalFooter";

export const metadata: Metadata = {
  title: "Terms of Use — Open Lounge",
  description: "The rules for using Open Lounge: zero tolerance for abuse, reporting and blocking, your content, payments, and the legal terms.",
};
export const dynamic = "force-static";

const H = ({ id, children }: { id?: string; children: React.ReactNode }) => (
  <h2 id={id} className="mt-8 mb-2 scroll-mt-20 text-base font-semibold text-zinc-100">
    {children}
  </h2>
);
const UL = ({ children }: { children: React.ReactNode }) => <ul className="mb-3 list-disc space-y-1.5 pl-5">{children}</ul>;
const L = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link className="underline underline-offset-2" href={href}>
    {children}
  </Link>
);
const Mail = () => (
  <a className="underline underline-offset-2" href={SUPPORT_MAILTO}>
    {SUPPORT_EMAIL}
  </a>
);

export default function Terms() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 text-sm leading-relaxed break-words text-zinc-300">
      <h1 className="mb-1 text-2xl font-bold text-zinc-100">Terms of Use</h1>
      <p className="mb-4 text-zinc-500">Last updated October 7, 2026</p>
      <p>
        These Terms of Use (&ldquo;Terms&rdquo;) are an agreement between you and <b>Global Network LLC</b> (&ldquo;Open Lounge,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;).
        They govern your use of the Open Lounge apps for iPhone and Android and openlounge.app (the &ldquo;Service&rdquo;). By creating an account or using the Service, you
        agree to these Terms and our <L href="/privacy">Privacy Policy</L>. If you don&apos;t agree, don&apos;t use the Service.
      </p>

      <H id="zero-tolerance">1. Acceptable use: zero tolerance for objectionable content and abusive users</H>
      <p>
        Open Lounge has <b>zero tolerance</b> for objectionable content or abusive behavior. We review reports within 24 hours, remove offending content, and suspend or
        permanently ban the accounts responsible, without notice. Don&apos;t post, say in a room, drop-in or call, or send in a message anything that:
      </p>
      <UL>
        <li>harasses, bullies, threatens, intimidates or doxxes anyone;</li>
        <li>
          is hateful or discriminatory, including slurs or attacks based on race, ethnicity, religion, nationality, disability, sex, gender identity, sexual orientation or
          age;
        </li>
        <li>is sexually explicit or pornographic, or sexualizes minors in any way (we report it to the authorities);</li>
        <li>promotes violence, terrorism, self-harm or suicide, or shows graphic violence;</li>
        <li>is spam, a scam, phishing, malware, or misleading impersonation of a person or organization;</li>
        <li>
          is illegal, infringes someone else&apos;s intellectual property or privacy, or <b>records other people without their consent</b>.
        </li>
      </UL>

      <H id="safety">2. Reporting, blocking and moderation</H>
      <UL>
        <li>
          <b>Report</b> any account, room, room-chat message or direct message from its Report option. Our team reviews reports within 24 hours.
        </li>
        <li>
          <b>Block</b> any account from their profile or your conversation. Blocked accounts can&apos;t message, call or invite you, and you won&apos;t see their messages.
          Manage blocks in Settings &gt; Blocked accounts.
        </li>
        <li>Open Lounge filters common profanity automatically and rejects slurs. Hosts can mute, move or remove people in their rooms.</li>
        <li>
          Moderators can remove content, end rooms, and suspend or ban accounts (see <a className="underline underline-offset-2" href="#termination">section 8</a>).
        </li>
        <li>
          For urgent safety concerns, email <Mail />. If someone is in immediate danger, contact local emergency services.
        </li>
      </UL>

      <H id="account">3. Your account</H>
      <UL>
        <li>
          You must be <b>18 or older</b> to use Open Lounge.
        </li>
        <li>Give accurate information, keep your sign-in methods secure, and don&apos;t share your account. You&apos;re responsible for activity on it.</li>
        <li>One person, one account. No automated or bulk accounts.</li>
        <li>
          Don&apos;t interfere with the Service: no scraping, reverse engineering, overloading it, or getting around security, blocks, suspensions or rate limits.
        </li>
      </UL>

      <H id="rooms">4. Rooms, drop-ins, calls and messages</H>
      <UL>
        <li>
          Live audio and video are relayed in real time and <b>aren&apos;t recorded by Open Lounge</b>. Anyone in a room can hear what you say. Don&apos;t record, rebroadcast
          or transcribe others without their consent and where the law allows.
        </li>
        <li>Room invites and links you share let the people you send them to join. Share them only with people you trust.</li>
        <li>Links may lead to third-party sites we don&apos;t control. We may warn you about suspicious links but aren&apos;t responsible for third-party content.</li>
        <li>
          If you use Find friends, you confirm you&apos;re allowed to use your contacts&apos; numbers this way. We handle them as our Privacy Policy describes, and we never
          message your contacts.
        </li>
      </UL>

      <H id="content">5. Your content and the licence you give us</H>
      <p>
        <b>You own the content you create</b>: profile details, room titles, chat, messages, and what you say in rooms and calls. You give Open Lounge a worldwide,
        non-exclusive, royalty-free licence to host, store, transmit, display and distribute that content only as needed to operate, secure and improve the Service and to
        enforce these Terms (for example, to review reported content). The licence ends when you delete the content or your account, except for copies kept for safety
        reports or legal obligations and messages already delivered to other people. You&apos;re responsible for your content and confirm you have the rights to share it.
      </p>
      <p className="mt-2">
        Some emoji and sticker artwork is provided by third parties and remains their property. Animated emoji by Google (Noto Emoji Animation) are licensed under CC BY 4.0.
        Third-party names and trademarks in links and previews belong to their owners.
      </p>

      <H id="payments">6. Payments and Premium</H>
      <p>
        Open Lounge is free to use. Some extras, such as sticker packs or a Premium plan if we offer one, may cost money. We always show the price and what you get before
        you pay, and prices may change for future purchases. If we offer Premium as a subscription, it renews automatically at the price shown until you cancel; cancelling
        stops the next renewal and you keep access until the end of the paid period.
      </p>

      <h3 id="digital-purchases" className="mt-5 mb-2 scroll-mt-20 font-semibold text-zinc-100">
        Digital purchases (stickers and Premium)
      </h3>
      <UL>
        <li>
          <b>Sold on the web only.</b> Paid stickers and Premium are sold only on openlounge.app, through <b>PayPal</b>, including <b>Apple Pay</b> and{" "}
          <b>Google Pay</b> where your browser supports them. The iPhone and Android apps don&apos;t sell anything. We never see or store your card number.
        </li>
        <li>
          <b>A licence, not ownership.</b> A purchase gives you a personal, non-transferable, revocable licence to use that content in Open Lounge with your account. It
          can&apos;t be resold, transferred or moved to another account.
        </li>
        <li>
          <b>Refunds</b> follow the payment processor&apos;s policy (PayPal, Apple Pay or Google Pay) and the law that applies to you. If something didn&apos;t work, email{" "}
          <Mail />.
        </li>
        <li>
          <b>Refunded or charged-back purchases are removed</b> from your account, including from My stickers.
        </li>
        <li>
          <b>Restore purchases</b> any time at <L href="/stickers/receipts">openlounge.app/stickers/receipts</L>, where your receipts are also listed.
        </li>
        <li>Purchases end if you delete your account or it&apos;s banned for breaking these Terms.</li>
        <li>
          Free sticker packs include Google&apos;s Noto Emoji Animation, licensed under CC BY 4.0. That credit stays on every pack page and in Settings &gt; About.
        </li>
      </UL>

      <H id="apple">7. Apple App Store and Google Play</H>
      <p>
        If you downloaded Open Lounge from the Apple App Store, these Terms are between you and Global Network LLC, not Apple. Apple isn&apos;t responsible for the app or
        its content, has no obligation to provide maintenance or support, and isn&apos;t responsible for any claims relating to the app, including product liability, legal or
        regulatory compliance, or intellectual-property claims. To the maximum extent permitted by law, Apple has no warranty obligation for the app. Apple and its
        subsidiaries are third-party beneficiaries of these Terms and may enforce them against you. You confirm you aren&apos;t located in a country subject to a U.S.
        Government embargo and aren&apos;t on any U.S. Government list of prohibited or restricted parties. Apple&apos;s standard Licensed Application End User License
        Agreement applies where relevant.
      </p>
      <p className="mt-2">
        If you downloaded Open Lounge from Google Play, these Terms are between you and Global Network LLC, not Google, and your use of Google Play is also governed by
        Google Play&apos;s Terms of Service.
      </p>

      <H id="termination">8. Suspension and termination</H>
      <p>
        We may remove any content and suspend or terminate any account, at any time and without notice, if we believe it breaks these Terms, puts people at risk, or exposes
        us to legal liability. To appeal, email <Mail />. You can stop using Open Lounge at any time and delete your account in Settings &gt; Account &gt; Delete account or
        at <L href="/privacy/delete-account">openlounge.app/privacy/delete-account</L>. Sections about licences already granted, payments owed, disclaimers, liability and
        disputes survive termination.
      </p>

      <H id="disclaimers">9. Disclaimers</H>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any kind, express or implied, including merchantability, fitness
        for a particular purpose and non-infringement. Content on Open Lounge comes from its members and doesn&apos;t reflect our views. We don&apos;t promise the Service will
        be uninterrupted, error-free or secure.
      </p>

      <H id="liability">10. Limitation of liability</H>
      <p>
        To the maximum extent permitted by law, Global Network LLC and its members, managers and staff aren&apos;t liable for indirect, incidental, special, consequential or
        punitive damages, lost profits or data, or the content or conduct of other members. Our total liability for any claim relating to the Service is limited to the
        greater of the amount you paid us in the 12 months before the claim or US$50. Some places don&apos;t allow these limits, so they may not apply to you.
      </p>

      <H id="law">11. Governing law and disputes</H>
      <p>
        These Terms are governed by the laws of the <b>State of Arizona</b>, USA, without regard to conflict-of-law rules. Disputes go to the state or federal courts in
        Maricopa County, Arizona, unless your local consumer law gives you the right to bring a claim where you live.
      </p>

      <H id="changes">12. Changes</H>
      <p>
        We may update these Terms. If the changes are significant, we&apos;ll tell you in the app before they take effect. If you keep using Open Lounge after an update, you
        accept it.
      </p>

      <H id="contact">13. Contact and support</H>
      <p>
        Questions, appeals or urgent safety concerns: <Mail /> · Global Network LLC, operator of Open Lounge · openlounge.app
      </p>
      <H id="credits">Credits</H>
      <p>
        Animated emoji by Google — Noto Animated Emoji, licensed under{" "}
        <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">
          CC BY 4.0
        </a>{" "}
        (resized and re-encoded). Animated emoji artwork © Telegram (telegram.org), via the Telegram-Animated-Emojis collection.
      </p>
      <LegalFooter className="mt-10 border-t border-white/5 pt-6" />
    </main>
  );
}
