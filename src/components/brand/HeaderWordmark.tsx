// Header "Open Lounge" wordmark: a subtle Threads-style letter wave every 10 s (~0.9 s, transform/opacity only),
// on the web and in the native app shells alike. Static under prefers-reduced-motion / low-end devices, and paused
// while the page is hidden (html[data-hidden], globals.css).
const TEXT = "Open Lounge";

export function HeaderWordmark() {
  return (
    <span className="ol-word ol-word-wave font-bold tracking-tight whitespace-nowrap" aria-label={TEXT}>
      {Array.from(TEXT).map((ch, i) => (
        <span key={i} aria-hidden="true" style={{ animationDelay: `${1200 + i * 32}ms` }}>
          {ch === " " ? "\u00a0" : ch}
        </span>
      ))}
    </span>
  );
}
