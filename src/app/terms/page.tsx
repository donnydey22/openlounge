import Link from "next/link";
import type { Metadata } from "next";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/support";
import { LegalFooter } from "@/components/safety/LegalFooter";

export const metadata: Metadata = { title: "Terms of Use — Open Lounge" };
export const dynamic = "force-static";

const H = ({ children, id }: { children: React.ReactNode; id?: string }) => (
  <h2 id={id} className="mt-6 mb-2 scroll-mt-6 text-base font-semibold text-zinc-100">
    {children}
  </h2>
);

export default function Terms() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-sm leading-relaxed text-zinc-300">
      <h1 className="mb-1 text-2xl font-bold text-zinc-100">Terms of Use (EULA)</h1>
      <p className="mb-4 text-zinc-500">Last updated October 7, 2026</p>
      <p>
        These Terms of Use (&ldquo;Terms&rdquo;) are an agreement between you and Open Lounge (&ldquo;we&rdquo;, &ldquo;us&rdquo;) and govern your use of the Open
        Lounge apps and openlounge.app (the &ldquo;Service&rdquo;). By creating an account or using the Service you agree to these Terms and to our{" "}
        <Link className="underline" href="/privacy">
          Privacy policy
        </Link>
        . If you don&apos;t agree, don&apos;t use the Service.
      </p>

      <H id="zero-tolerance">Zero tolerance for objectionable content and abusive users</H>
      <p className="mb-2 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-zinc-200">
        Open Lounge has <b>no tolerance</b> for objectionable content or abusive behaviour. We review reports within 24 hours, remove offending content and
        suspend or permanently ban the accounts responsible, without notice.
      </p>
      <p>You must not post, say in a room, or send any content that:</p>
      <ul className="mb-3 list-disc space-y-1 pl-5">
        <li>harasses, bullies, threatens, intimidates or doxxes anyone;</li>
        <li>is hateful or discriminatory, including slurs, or attacks people based on race, ethnicity, religion, nationality, disability, sex, gender identity, sexual orientation or age;</li>
        <li>is sexually explicit or pornographic, or sexualises minors in any way (reported to the authorities);</li>
        <li>promotes violence, terrorism, self-harm or suicide, or depicts graphic violence;</li>
        <li>is spam, a scam, phishing, malware, or misleading impersonation of a person or organisation;</li>
        <li>is illegal, infringes someone else&apos;s intellectual property or privacy, or records others without their consent.</li>
      </ul>

      <H>Reporting and blocking</H>
      <p>
        You can report any account, room, room chat message or direct message from the &ldquo;⋯&rdquo; / Report options in the app, and block any account from their
        profile or your conversation with them. Blocked accounts can&apos;t message you, and you won&apos;t see their messages. Manage blocked accounts in Settings &gt;
        Blocked accounts. Open Lounge also automatically filters common profanity and rejects slurs.
      </p>

      <H>Your account and responsibilities</H>
      <ul className="mb-3 list-disc space-y-1 pl-5">
        <li>You must be at least 13 years old (or the minimum age in your country) to use Open Lounge.</li>
        <li>Give accurate information, keep your sign-in methods secure, and don&apos;t share your account. You are responsible for activity on your account.</li>
        <li>Don&apos;t interfere with the Service: no scraping, automated accounts, reverse engineering, overloading or circumventing security or blocks.</li>
        <li>Respect hosts and other members. Hosts may move, mute or remove participants in their rooms.</li>
        <li>Follow all applicable laws.</li>
      </ul>

      <H>Your content and the licence you give us</H>
      <p>
        You own the content you create (profile details, room titles, chat and messages, and what you say in rooms). You give Open Lounge a worldwide, non-exclusive,
        royalty-free licence to host, store, transmit, display and distribute that content only as needed to operate and improve the Service and to enforce these
        Terms (for example, reviewing reported content). This licence ends when you delete the content or your account, except for copies kept for safety reports,
        legal obligations, or messages already delivered to other people. You are responsible for your content and confirm you have the rights to share it.
      </p>
      <p className="mt-2">Room audio is relayed live and is not recorded by Open Lounge. Others in a room may hear anything you say, so be thoughtful.</p>

      <H>Moderation, suspension and termination</H>
      <p>
        We may remove any content and suspend or terminate any account, at any time and without notice, if we believe it breaks these Terms, puts people at risk, or
        exposes us to legal liability. You can stop using Open Lounge at any time and delete your account in Settings &gt; Delete account. Sections about content
        licences already used, disclaimers and liability survive termination.
      </p>

      <H>Apple App Store terms</H>
      <p>
        If you downloaded Open Lounge from the Apple App Store: these Terms are between you and Open Lounge, not Apple. Apple is not responsible for the app or its
        content, has no obligation to provide maintenance or support, and is not responsible for any claims relating to the app (including product liability,
        legal or regulatory compliance, or intellectual-property claims). To the maximum extent permitted by law, Apple has no warranty obligation for the app.
        Apple and its subsidiaries are third-party beneficiaries of these Terms and may enforce them against you. You confirm you are not located in a country
        subject to a U.S. Government embargo and are not on any U.S. Government list of prohibited or restricted parties. Your use is also subject to Apple&apos;s
        standard Licensed Application End User License Agreement where it applies.
      </p>

      <H>Disclaimers and limitation of liability</H>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without warranties of any kind. Content on Open Lounge comes from its members and does not
        reflect our views. To the maximum extent permitted by law, Open Lounge is not liable for indirect, incidental or consequential damages, or for content or
        conduct of other members.
      </p>

      <H>Changes</H>
      <p>We may update these Terms. If the changes are significant we&apos;ll let you know in the app. Continuing to use Open Lounge after an update means you accept it.</p>

      <H id="contact">Contact &amp; support</H>
      <p>
        Questions, appeals or urgent safety concerns: email openloungeapp-support at{" "}
        <a className="underline" href={SUPPORT_MAILTO}>
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
      <LegalFooter className="mt-10 border-t border-white/5 pt-6" />
    </main>
  );
}
