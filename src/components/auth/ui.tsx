"use client";

// Shared building blocks for the sign-in screens (AuthFlow, /forgot-password, /reset-password, /verify-email,
// /auth/complete) so every auth page has the same Clubhouse-style look in light and dark.

import { useState } from "react";
import { ArrowLeft, Eye, EyeOff, Loader2 } from "lucide-react";

export function Shell({ children, onBack, stepKey, welcome }: { children: React.ReactNode; onBack?: () => void; stepKey: string; welcome?: boolean }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <div className="h-11">
        {onBack && (
          <button onClick={onBack} className="-ml-2 rounded-full p-2 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 active:scale-95" aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
      </div>
      <div key={stepKey} className={"flex flex-1 flex-col " + (welcome ? "auth-welcome-in" : "auth-step-in")}>
        {children}
      </div>
    </main>
  );
}

export function Title({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="pt-6 text-center">
      <h1 className="text-[26px] leading-tight font-bold tracking-tight">{children}</h1>
      {sub && <p className="mt-2 text-[15px] text-zinc-400">{sub}</p>}
    </div>
  );
}

export function Footer({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto pt-8 pb-[max(2rem,env(safe-area-inset-bottom))]">{children}</div>;
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  busy,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className="flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-4 text-[17px] font-semibold text-on-accent shadow-lg shadow-emerald-500/20 transition duration-200 hover:bg-emerald-400 active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : children}
    </button>
  );
}

export function TextInput({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <input
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3.5 text-lg outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
    />
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-3 text-center text-sm text-red-400">{children}</p>;
}


/** Password field with a show/hide toggle (same look as TextInput). */
export function PasswordInput({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        {...rest}
        type={show ? "text" : "password"}
        value={value}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-zinc-900 py-3.5 pr-12 pl-4 text-lg outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1.5 text-zinc-500 hover:text-zinc-300"
      >
        {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
}

/** Small inline notice (success / info) under a form — never used for session errors. */
export function NoteText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-3 text-center text-sm text-emerald-400">{children}</p>;
}
