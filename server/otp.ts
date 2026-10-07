// Phone verification (OTP) with a pluggable SMS provider.
//
// Demo mode (default, no keys): codes are logged to the server console and returned
// to the client so the UI can show them on screen. The fixed code 000000 also works.
// Production: implement SmsProvider for a real gateway and select it in createSmsProvider() — no client changes needed.
// (The old Twilio provider was removed: it was never configured and Twilio is not used by this project.)

import { createHash, randomInt } from "node:crypto";

export interface SmsProvider {
  readonly name: string;
  /** true when codes may be revealed to the client (never for real providers) */
  readonly revealsCodes: boolean;
  send(toE164: string, body: string): Promise<void>;
}

class DemoSmsProvider implements SmsProvider {
  readonly name = "demo";
  readonly revealsCodes = true;
  async send(to: string, body: string) {
    console.log(`[sms:demo] → ${to}: ${body}`);
  }
}

export function createSmsProvider(): SmsProvider {
  if (process.env.SMS_PROVIDER && process.env.SMS_PROVIDER !== "demo")
    throw new Error(`SMS_PROVIDER=${process.env.SMS_PROVIDER} is not supported (only "demo" is built in)`);
  return new DemoSmsProvider();
}

/** Normalize "+1", "(415) 555-0123" → "+14155550123". Returns null if implausible. */
export function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function maskPhone(e164: string) {
  return e164.length > 6 ? `${e164.slice(0, e164.length - 7)} ••• ${e164.slice(-4)}` : e164;
}

const CODE_TTL_MS = 5 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;
const MAX_ATTEMPTS = 5;
const DEMO_FIXED_CODE = "000000";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

interface Pending {
  codeHash: string;
  expiresAt: number;
  sentAt: number;
  attempts: number;
}

export class OtpService {
  private pending = new Map<string, Pending>();
  constructor(readonly provider: SmsProvider = createSmsProvider()) {}

  async request(phone: string): Promise<{ ok: true; demoCode?: string; resendIn: number } | { ok: false; error: string; resendIn?: number }> {
    const now = Date.now();
    const existing = this.pending.get(phone);
    if (existing && now - existing.sentAt < RESEND_COOLDOWN_MS) {
      const resendIn = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.sentAt)) / 1000);
      return { ok: false, error: `Please wait ${resendIn}s before requesting another code`, resendIn };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending.set(phone, { codeHash: hash(phone + code), expiresAt: now + CODE_TTL_MS, sentAt: now, attempts: 0 });
    try {
      await this.provider.send(phone, `Your Open Lounge code is ${code}. It expires in 5 minutes.`);
    } catch (err) {
      this.pending.delete(phone);
      console.error("[otp] send failed", err);
      return { ok: false, error: "We couldn't text that number. Try again." };
    }
    return { ok: true, resendIn: RESEND_COOLDOWN_MS / 1000, ...(this.provider.revealsCodes ? { demoCode: code } : {}) };
  }

  verify(phone: string, rawCode: unknown): { ok: true } | { ok: false; error: string } {
    const code = String(rawCode ?? "").replace(/\D/g, "");
    if (this.provider.revealsCodes && code === DEMO_FIXED_CODE) {
      this.pending.delete(phone);
      return { ok: true };
    }
    const p = this.pending.get(phone);
    if (!p || Date.now() > p.expiresAt) return { ok: false, error: "That code expired. Request a new one." };
    if (++p.attempts > MAX_ATTEMPTS) {
      this.pending.delete(phone);
      return { ok: false, error: "Too many attempts. Request a new code." };
    }
    if (hash(phone + code) !== p.codeHash) return { ok: false, error: "That code doesn't match. Try again." };
    this.pending.delete(phone);
    return { ok: true };
  }
}
