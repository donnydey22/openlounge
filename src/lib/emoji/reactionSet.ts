// Message-reaction picker: the animated set (Google or Fluent) last used on THIS device (localStorage, no server sync).
// Kept apart from the composer picker's tab (ol:emojiTab). Static/system emoji are never remembered. Default Google.
export const REACTION_SET_KEY = "ol:reactionSet";
export function readReactionSet(): "google" | "fluent" {
  try {
    return localStorage.getItem(REACTION_SET_KEY) === "fluent" ? "fluent" : "google";
  } catch {
    return "google";
  }
}
export function saveReactionSet(t: "google" | "fluent") {
  try {
    localStorage.setItem(REACTION_SET_KEY, t);
  } catch {
    /* private mode / quota */
  }
}
