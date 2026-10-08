// Transactional email (codes, verification, password reset). Two transports, picked by MAIL_TRANSPORT=gmail_api|smtp
// (unset → Gmail API if configured, else SMTP): Gmail API over HTTPS (./gmail.ts, see docs/EMAIL_GMAIL_API.md) or
// SMTP with nodemailer: SMTP_HOST, SMTP_PORT (default 587; 465 = implicit TLS), SMTP_USER, SMTP_PASS, SMTP_FROM.
// Not configured → nothing is sent: in dev the message (with its link) is logged so you can click it; in production
// only a redacted line is logged (links are bearer secrets). Sending never throws to callers.

import nodemailer, { type Transporter } from "nodemailer";
import { mailTransport, smtpConfigured } from "./providers";
import { gmailSend } from "./gmail";

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
  /** a 6-digit sign-in code (logged in dev when SMTP is off; never in production) */
  code?: string;
}

/** Sent mails are recorded here when NODE_ENV=test (assertions in tests). */
export const outbox: Mail[] = [];

export async function sendMail(mail: Mail): Promise<boolean> {
  if (process.env.NODE_ENV === "test") outbox.push(mail);
  const kind = mailTransport();
  const t = kind === "smtp" ? getTransport() : null;
  if (!kind || (kind === "smtp" && !t)) {
    if (process.env.NODE_ENV !== "production") console.log(`[mail:dev] mail not configured — to ${mail.to}: "${mail.subject}"${mail.link ? `\n[mail:dev] link: ${mail.link}` : ""}${mail.code ? `\n[mail:dev] code: ${mail.code}` : ""}`);
    else console.warn(`[mail] mail not configured — dropped "${mail.subject}" to ${maskEmail(mail.to)}`);
    return false;
  }
  try {
    if (kind === "gmail_api") await gmailSend(mail);
    else await t!.sendMail({ from: process.env.SMTP_FROM!.trim(), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    console.log(`[mail] sent via ${kind} "${mail.subject}" to ${maskEmail(mail.to)}`);
    return true;
  } catch (err) {
    console.error(`[mail] ${kind} send failed for "${mail.subject}" to ${maskEmail(mail.to)}: ${(err as Error)?.message ?? err}`);
    return false;
  }
}

// ---------- templates ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Header replicates the live app header (openlounge main fd031ff, src/components/TopBar.tsx + src/app/globals.css):
// background --color-app #0b0b0d (bg-app/80 over the #0b0b0d page), border-b white/5, h-16 (64px), px-4 (16px);
// 🎙️ at text-2xl (24px/32px), gap-2 (8px), wordmark text-lg (18px/28px) font-bold, tracking-tight (-0.025em),
// color zinc-100 (#f4f4f5), body font stack as computed on openlounge.app. No logo image — the site uses the emoji + text.
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue','Noto Sans',Arial,sans-serif,'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol','Noto Color Emoji'`; // computed on openlounge.app
const SITE = "https://openlounge.app";

export function layout(o: { preheader: string; title: string; lead: string; intro: string; code?: string; codeNote?: string; button?: { label: string; url: string }; outro: string }) {
  const btn = o.button
    ? `<tr><td align="center" style="padding:4px 32px 20px"><a href="${esc(o.button.url)}" style="display:inline-block;background:#10b981;color:#06281d;font-weight:600;font-size:16px;line-height:20px;text-decoration:none;padding:14px 28px;border-radius:999px">${esc(o.button.label)}</a></td></tr>
<tr><td style="font-size:12px;line-height:18px;color:#71717a;padding:0 32px 20px;word-break:break-all">Button not working? Paste this link into your browser:<br><span style="color:#047857">${esc(o.button.url)}</span></td></tr>`
    : "";
  const code = o.code
    ? `<tr><td align="center" style="padding:4px 32px 8px"><table role="presentation" cellpadding="0" cellspacing="0" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:999px"><tr><td style="padding:14px 28px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;line-height:40px;font-weight:700;letter-spacing:0.3em;color:#064e3b;-webkit-user-select:all;user-select:all">${esc(o.code)}</td></tr></table></td></tr>
<tr><td align="center" style="font-size:14px;line-height:20px;color:#52525b;padding:8px 32px 24px">${esc(o.codeNote ?? "")}</td></tr>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f3ee;font-family:${FONT};color:#18181b;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(o.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3ee"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #ebeae4">
<tr><td bgcolor="#0b0b0d" style="background:#0b0b0d;border-bottom:1px solid rgba(255,255,255,0.05);height:64px;padding:0 16px">
<a href="${SITE}" style="text-decoration:none;color:#f4f4f5"><span style="font-size:24px;line-height:32px;vertical-align:middle">🎙️</span><span style="display:inline-block;width:8px"></span><span style="font-size:18px;line-height:28px;font-weight:700;letter-spacing:-0.45px;color:#f4f4f5;vertical-align:middle;white-space:nowrap">Open Lounge</span></a>
</td></tr>
<tr><td style="background-color:#ecfdf5;background-image:linear-gradient(180deg,#d1fae5 0%,#ffffff 100%);padding:32px 32px 8px">
<div style="font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.02em;color:#18181b">${esc(o.title)}</div>
<div style="font-size:15px;line-height:22px;color:#047857;padding-top:6px">${esc(o.lead)}</div></td></tr>
<tr><td style="font-size:15px;line-height:23px;color:#3f3f46;padding:16px 32px 20px">${o.intro}</td></tr>
${code}${btn}
<tr><td style="font-size:13px;line-height:20px;color:#71717a;padding:0 32px 8px">${o.outro}</td></tr>
<tr><td style="font-size:15px;line-height:22px;color:#18181b;padding:12px 32px 32px">See you in the lounge,<br><span style="font-weight:600">The Open Lounge team</span></td></tr>
</table>
<p style="font-size:12px;line-height:18px;color:#71717a;margin:16px 0 0">Open Lounge · <a href="${SITE}" style="color:#71717a">openlounge.app</a> · <a href="${SITE}/privacy" style="color:#71717a">Privacy</a></p>
</td></tr></table></body></html>`;
  const strip = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
  const text = [
    `Open Lounge — ${o.title}`, o.lead, "", strip(o.intro), "",
    o.code ? `Your code: ${o.code}` : "", o.code && o.codeNote ? o.codeNote : "",
    o.button ? `${o.button.label}: ${o.button.url}` : "", "", strip(o.outro), "",
    "See you in the lounge,", "The Open Lounge team", "", `Open Lounge · ${SITE} · Privacy: ${SITE}/privacy`,
  ].filter((l, i, a) => l || a[i - 1]).join("\n");
  return { html, text };
}

const IGNORE = "If you didn't request this, you can ignore this email.";
const LEAD = "Live conversations with friends, happening now.";

export function verifyEmailMail(to: string, url: string, linking: boolean): Mail {
  const { html, text } = layout({
    preheader: "Confirm your email to finish setting up Open Lounge.",
    title: linking ? "Confirm your email" : "Welcome to Open Lounge 🎙️",
    lead: LEAD,
    intro: linking
      ? "Tap the button to add this email and password as a way to sign in to your Open Lounge account."
      : "You're almost in. Confirm your email, then pick your name and username.",
    button: { label: "Confirm email", url },
    outro: `This link expires in 24 hours. ${IGNORE}`,
  });
  return { to, subject: "Confirm your email for Open Lounge", html, text, link: url };
}

export function alreadyRegisteredMail(to: string, signInUrl: string, resetUrl: string): Mail {
  const { html, text } = layout({
    preheader: "This email already has an Open Lounge account.",
    title: "Welcome back",
    lead: "You already have a seat in the lounge.",
    intro: `Someone (hopefully you) tried to sign up with this email, but it's already on an Open Lounge account. <a href="${esc(signInUrl)}" style="color:#047857">Sign in</a> instead, or reset your password if you forgot it.`,
    button: { label: "Reset password", url: resetUrl },
    outro: "If this wasn't you, you can ignore this email. Your account is unchanged.",
  });
  return { to, subject: "Your Open Lounge account", html, text, link: resetUrl };
}

export function resetPasswordMail(to: string, url: string, hasPassword: boolean): Mail {
  const { html, text } = layout({
    preheader: hasPassword ? "Choose a new password for Open Lounge." : "Set a password for Open Lounge.",
    title: hasPassword ? "Reset your password" : "Set a password",
    lead: "Let's get you back into the lounge.",
    intro: hasPassword
      ? "We got a request to reset the password for your Open Lounge account. Tap the button to choose a new one."
      : "Your Open Lounge account doesn't have a password yet (you've been signing in another way). Tap the button to set one, so you can also sign in with this email.",
    button: { label: hasPassword ? "Choose a new password" : "Set a password", url },
    outro: `This link expires in 30 minutes and works once. Changing your password signs you out on every device. ${IGNORE}`,
  });
  return { to, subject: hasPassword ? "Reset your Open Lounge password" : "Set your Open Lounge password", html, text, link: url };
}

/** returning: the email already belongs to an account (sign-in) → "Welcome back" variant */
export function emailCodeMail(to: string, code: string, linking: boolean, returning = false): Mail {
  const { html, text } = layout({
    preheader: linking ? "Your code to add this email to Open Lounge." : "Your Open Lounge sign-in code is inside. It expires in 10 minutes.",
    title: linking ? "Confirm your email" : returning ? "Welcome back 🎙️" : "Your seat in the lounge is ready",
    lead: LEAD,
    intro: linking
      ? "Here's your code to add this email to your Open Lounge account."
      : returning ? "Good to see you again. Here's your code to hop back in." : "Here's your code to come on in.",
    code,
    codeNote: linking ? "Enter this code in Open Lounge Settings. It expires in 10 minutes." : "Enter this code in Open Lounge. It expires in 10 minutes.",
    outro: `Never share this code. Open Lounge will never ask you for it. ${IGNORE}`,
  });
  return { to, subject: linking ? "Your Open Lounge verification code" : "Your Open Lounge sign-in code", html, text, code };
}
