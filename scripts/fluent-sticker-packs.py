#!/usr/bin/env python3
"""Build server/stickers/fluent-packs.json from public/emoji/fluent/manifest.json (Microsoft Fluent Emoji Animated, MIT).
Files are served in place from public/emoji/fluent via /sticker-files/fluent/<cp>.webp (poster: fluent/p/<cp>.webp)."""
import json, re, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
m = json.load(open(os.path.join(ROOT, "public/emoji/fluent/manifest.json")))
ATTR = {
  "text": "Animated emoji from Microsoft Fluent Emoji Animated, MIT License, Copyright (c) Microsoft Corporation. Resized and repackaged as stickers by Open Lounge.",
  "author": "Microsoft (Fluent Emoji Animated)",
  "source": "https://github.com/microsoft/fluentui-emoji-animated",
  "license": "MIT",
  "licenseUrl": "/emoji/fluent/LICENSE",
}
HANDS = re.compile(r"hand|fist|thumbs|clap|finger|palm|index|\bok\b|victory|call me|horns|vulcan|pinch|nail|writing|muscle|leg|foot|footprint|\beyes?\b|\bear\b|nose|mouth|tongue|lips|brain|bone|tooth|handshake|pray|selfie", re.I)
SPORT = re.compile(r"run|surf|swim|lifting|golf|snowboard|horse racing|bik|ski|climb|cartwheel|juggl|bouncing ball|rowing|walking|kneeling|standing|dancing|lotus|bath|bed|fencer|wrestl|water polo|handball|sauna|steamy|massage|haircut", re.I)
HEART = re.compile(r"heart|kiss mark|love letter", re.I)
PACKS = [
  ("fluent-faces", "Fluent Faces", "Emotions", "Microsoft's glossy 3D faces for every mood."),
  ("fluent-love", "Fluent Hearts", "Love", "Fluent hearts that beat, sparkle and mend."),
  ("fluent-hands", "Fluent Hands & Body", "Gestures", "Waves, thumbs, claps, eyes and more."),
  ("fluent-people", "Fluent People", "People", "People, jobs, families and fantasy folks."),
  ("fluent-active", "Fluent On the Move", "Activities", "Running, surfing, dancing and relaxing."),
  ("fluent-animals", "Fluent Animals & Nature", "Animals", "Animals, plants and the great outdoors."),
  ("fluent-world", "Fluent Travel & Weather", "Travel", "Sun, moon, stars, cars, rockets and places."),
  ("fluent-party", "Fluent Party & Food", "Celebrations", "Drinks, cake, flags, music and party poppers."),
]
def pack_of(v):
  g, n = v["group"], v["name"]
  if HEART.search(n) and g in ("Smileys & Emotion", "People & Body"): return "fluent-love"
  if g == "Smileys & Emotion": return "fluent-faces"
  if g == "People & Body":
    if HANDS.search(n): return "fluent-hands"
    if SPORT.search(n): return "fluent-active"
    return "fluent-people"
  if g == "Animals & Nature": return "fluent-animals"
  if g == "Travel & Places": return "fluent-world"
  return "fluent-party"
by = {p[0]: [] for p in PACKS}
for cp, v in m["files"].items():
  by[pack_of(v)].append({
    "id": "fl-" + cp, "emoji": v["emoji"], "keywords": sorted(set([v["name"]] + v.get("tags", [])))[:8],
    "format": "webp", "file": f"fluent/{cp}.webp", "poster": f"fluent/p/{cp}.webp", "w": 160, "h": 160, "bytes": v.get("bytes"),
  })
COVER = {"fluent-faces": "1f600", "fluent-love": "2764", "fluent-hands": "1f44b", "fluent-people": "1f9d1", "fluent-active": "1f3c3",
         "fluent-animals": "1f98a", "fluent-world": "1f680", "fluent-party": "1f389"}
out = []
for pid, title, cat, desc in PACKS:
  st = by[pid]
  if not st: continue
  ids = [s["id"][3:] for s in st]
  cover = COVER[pid] if COVER[pid] in ids else ids[0]
  def rank(s):
    c = s["id"][3:]; n = int(c.split("_")[0], 16)
    # cover first, then the classic smiley/gesture blocks, then everything else in code point order
    return (c != cover, 0 if 0x1F600 <= n <= 0x1F64F else 1 if 0x1F910 <= n <= 0x1F9FF else 2, n, c)
  st.sort(key=rank)
  first = next(s for s in st if s["id"][3:] == cover)
  out.append({"id": pid, "title": title, "emoji": first["emoji"], "category": cat, "description": desc, "priceCents": 0, "currency": "USD",
              "published": True, "builtin": True, "cover": cover, "attribution": ATTR, "stickers": st})
assert sum(len(p["stickers"]) for p in out) == m["count"] == len(m["files"])
json.dump({"source": m["origin"], "revision": m["revision"], "packs": out}, open(os.path.join(ROOT, "server/stickers/fluent-packs.json"), "w"), ensure_ascii=False, indent=1)
for p in out: print(p["id"], len(p["stickers"]), p["cover"], p["emoji"])
