// Never send real mail to addresses that can't exist. RFC 2606 / RFC 6761 reserve example.com/.net/.org and the
// .test / .example / .invalid / .localhost TLDs: Gmail accepts the send, then bounces "Address not found" into the
// sender's inbox (outthereendlessly@gmail.com). Automated checks must use these, so they are dropped here.
import { sendMail, type Mail } from "./mailer";

const RESERVED = /(^|\.)(example\.(com|net|org)|[^.]+\.(test|example|invalid|localhost))$/i;

export function isReservedAddress(to: string): boolean {
  const domain = String(to ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return !domain || RESERVED.test(domain) || domain === "localhost";
}

/** sendMail, except reserved/test domains are skipped (logged, never delivered). Same boolean contract. */
export async function safeSendMail(mail: Mail): Promise<boolean> {
  if (isReservedAddress(mail.to)) {
    console.log(`[mail] skipped reserved test address (${mail.subject})`);
    if (process.env.NODE_ENV === "test") (await import("./mailer")).outbox.push(mail); // tests still assert content
    return false;
  }
  return sendMail(mail);
}
