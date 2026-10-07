// Header "Open Lounge" wordmark: a bold letter wave every 5 s (~1.1 s, transform/opacity only),
// on the web and in the native app shells alike. Static under prefers-reduced-motion / low-end devices, and paused
// while the page is hidden (html[data-hidden], globals.css).
const TEXT = "Open Lounge";

export function HeaderWordmark() {
  return (
    <span className="ol-word ol-word-wave font-bold tracking-tight whitespace-nowrap" aria-label={TEXT}>
      {Array.from(TEXT).map((ch, i) => (
        <span key={i} aria-hidden="true" style={{ animationDelay: `${1200 + i * 45}ms` }}>
          {ch === " " ? "\u00a0" : ch}
        </span>
      ))}
    </span>
  );
}
