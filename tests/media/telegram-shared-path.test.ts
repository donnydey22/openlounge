import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("image files and original GIFs use the Telegram decode-gated media path", () => {
  const bubble = read("src/components/media/MediaBubble.tsx");

  // The shared helper hides a sharp bitmap until the browser decoder has completed. Its callers retain a
  // placeholder or icon, so this is not a spinner-based loading path.
  assert.match(bubble, /function DecodeGatedImage\(/);
  assert.match(bubble, /image\.decode \? image\.decode\(\) : Promise\.resolve\(\)/);
  assert.match(bubble, /!decoded && "opacity-0"/);
  assert.match(bubble, /placeholder && <img[^>]*blur-xl/);

  // Send-as-file images are documents, so their thumbnail must no longer render through a raw image element.
  const documentTile = bubble.slice(bubble.indexOf("function DocumentTile"), bubble.indexOf("function InlineExpiry"));
  assert.match(documentTile, /<DecodeGatedImage src=\{urls\.thumb\} placeholder=\{a\.ph\}/);
  assert.match(documentTile, /testId="media-document-thumb"/);
  assert.doesNotMatch(documentTile, /<img src=\{urls\.thumb\}/);

  // A GIF still awaiting video conversion also stays behind its existing thumbnail until it is decoded.
  const inlineVideo = bubble.slice(bubble.indexOf("function InlineVideo"), bubble.indexOf("// ---------- documents ----------"));
  assert.match(inlineVideo, /<DecodeGatedImage src=\{src\}/);
  assert.match(inlineVideo, /testId="media-gif-inline"/);
  assert.doesNotMatch(inlineVideo, /return <img src=\{src\}/);
});

test("normal uploads, pastes, and group conversation media remain on the shared bubble and viewer", () => {
  const composer = read("src/components/media/MediaComposer.tsx");
  const thread = read("src/components/chat/DmThread.tsx");
  const roomChat = read("src/components/chat/RoomChatPanel.tsx");

  assert.match(composer, /source: "paste"/);
  assert.match(composer, /queueAlbum\(/);
  assert.match(composer, /queueMedia\(/);
  assert.match(thread, /<MediaBubble m=\{m\}/);
  assert.match(thread, /<MediaLayer socket=\{socket\}/);

  // Live room chat is intentionally text/sticker-only today. It has neither a media upload control nor a raw
  // image/video element, so it cannot bypass the shared-media renderer without a separate product feature.
  assert.doesNotMatch(roomChat, /MediaAttach|<img\b|<video\b/);
});
