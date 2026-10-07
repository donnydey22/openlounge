// Transactional email (verification + password reset) over SMTP with nodemailer.
// SMTP_HOST, SMTP_PORT (default 587; 465 = implicit TLS), SMTP_USER, SMTP_PASS, SMTP_FROM.
// Not configured → nothing is sent: in dev the message (with its link) is logged so you can click it; in production
// only a redacted line is logged (links are bearer secrets). Sending never throws to callers.

import nodemailer, { type Transporter } from "nodemailer";
import { smtpConfigured } from "./providers";

let transport: Transporter | null = null;
let transportKey = "";

function getTransport(): Transporter | null {
  if (!smtpConfigured()) return null;
  const host = process.env.SMTP_HOST!.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS ?? "";
  const key = `${host}:${port}:${user ?? ""}`;
  if (transport && transportKey === key) return transport;
  transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587, // submission port: insist on STARTTLS (465 is implicit TLS; others opportunistic)
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  transportKey = key;
  return transport;
}

export const maskEmail = (e: string) => {
  const [local, domain] = e.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(6, local.length - 1)))}@${domain}`;
};

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** the action link (logged in dev when SMTP is off) */
  link?: string;
}

/** Sent mails are recorded here when NODE_ENV=test (assertions in tests). */
export const outbox: Mail[] = [];

export async function sendMail(mail: Mail): Promise<boolean> {
  if (process.env.NODE_ENV === "test") outbox.push(mail);
  const t = getTransport();
  if (!t) {
    if (process.env.NODE_ENV !== "production") console.log(`[mail:dev] SMTP not configured — to ${mail.to}: "${mail.subject}"${mail.link ? `\n[mail:dev] link: ${mail.link}` : ""}`);
    else console.warn(`[mail] SMTP not configured — dropped "${mail.subject}" to ${maskEmail(mail.to)}`);
    return false;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM!.trim(), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    console.log(`[mail] sent "${mail.subject}" to ${maskEmail(mail.to)}`);
    return true;
  } catch (err) {
    console.error(`[mail] send failed for "${mail.subject}" to ${maskEmail(mail.to)}: ${(err as Error)?.message ?? err}`);
    return false;
  }
}

// ---------- templates ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(o: { title: string; intro: string; button?: { label: string; url: string }; outro: string }) {
  const btn = o.button
    ? `<tr><td align="center" style="padding:8px 0 24px"><a href="${esc(o.button.url)}" style="display:inline-block;background:#10b981;color:#06281d;font-weight:600;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:999px">${esc(o.button.label)}</a></td></tr>
<tr><td style="font-size:13px;color:#71717a;padding-bottom:20px;word-break:break-all">Or paste this link into your browser:<br><a href="${esc(o.button.url)}" style="color:#0ea5e9">${esc(o.button.url)}</a></td></tr>`
    : "";
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(o.title)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;padding:32px">
<tr><td align="center" style="font-size:44px;padding-bottom:8px">🎙️</td></tr>
<tr><td align="center" style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#10b981;padding-bottom:16px">Open Lounge</td></tr>
<tr><td style="font-size:22px;font-weight:700;padding-bottom:12px">${esc(o.title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#3f3f46;padding-bottom:24px">${o.intro}</td></tr>
${btn}
<tr><td style="font-size:13px;line-height:1.5;color:#71717a">${o.outro}</td></tr>
</table>
<p style="font-size:12px;color:#a1a1aa;margin:16px 0 0">Open Lounge · live audio rooms</p>
</td></tr></table></body></html>`;
  const text = [`Open Lounge — ${o.title}`, "", o.intro.replace(/<[^>]+>/g, ""), "", o.button ? `${o.button.label}: ${o.button.url}` : "", "", o.outro.replace(/<[^>]+>/g, "")]
    .filter((l, i, a) => l || a[i - 1])
    .join("\n");
  return { html, text };
}

export function verifyEmailMail(to: string, url: string, linking: boolean): Mail {
  const { html, text } = layout({
    title: linking ? "Confirm your email" : "Confirm your email to finish signing up",
    intro: linking
      ? "Tap the button to add this email and password as a way to sign in to your Open Lounge account."
      : "Welcome! Tap the button to confirm your email and pick your name and username.",
    button: { label: "Confirm email", url },
    outro: "This link expires in 24 hours. If you didn't ask for this, you can ignore this email — nothing changes.",
  });
  return { to, subject: "Confirm your email for Open Lounge", html, text, link: url };
}

export function alreadyRegisteredMail(to: string, signInUrl: string, resetUrl: string): Mail {
  const { html, text } = layout({
    title: "You already have an account",
    intro: `Someone (hopefully you) tried to sign up with this email, but it's already on an Open Lounge account. <a href="${esc(signInUrl)}" style="color:#0ea5e9">Sign in</a> instead, or reset your password if you forgot it.`,
    button: { label: "Reset password", url: resetUrl },
    outro: "If this wasn't you, ignore this email — your account is unchanged.",
  });
  return { to, subject: "Your Open Lounge account", html, text, link: resetUrl };
}

export function resetPasswordMail(to: string, url: string, hasPassword: boolean): Mail {
  const { html, text } = layout({
    title: hasPassword ? "Reset your password" : "Set a password",
    intro: hasPassword
      ? "We got a request to reset the password for your Open Lounge account. Tap the button to choose a new one."
      : "Your Open Lounge account doesn't have a password yet (you've been signing in another way). Tap the button to set one, so you can also sign in with this email.",
    button: { label: hasPassword ? "Choose a new password" : "Set a password", url },
    outro: "This link expires in 30 minutes and works once. Changing your password signs you out on every device. If you didn't ask for this, ignore this email.",
  });
  return { to, subject: hasPassword ? "Reset your Open Lounge password" : "Set your Open Lounge password", html, text, link: url };
}
