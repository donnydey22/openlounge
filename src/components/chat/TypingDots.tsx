/** Three dots bouncing in sequence (reduced motion → gentle fade, see .typing-dot in globals.css). */
export function TypingDots({ className = "bg-current" }: { className?: string }) {
  return (
    <span className="inline-flex items-center gap-[3px] align-middle" aria-hidden>
      <span className={`typing-dot h-1 w-1 rounded-full ${className}`} />
      <span className={`typing-dot h-1 w-1 rounded-full ${className} [animation-delay:150ms]`} />
      <span className={`typing-dot h-1 w-1 rounded-full ${className} [animation-delay:300ms]`} />
    </span>
  );
}

/** "typing" + animated dots, used in the DM list row and the strip above the composer. */
export function TypingLabel({ testId }: { testId?: string }) {
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1.5 text-emerald-400" role="status" aria-label="typing">
      <span>typing</span>
      <TypingDots />
    </span>
  );
}
