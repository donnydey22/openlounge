process.env.TEST_DATABASE_URL ||= "postgresql://ua@127.0.0.1:55433/invites_test";
// short drop-in grace + low limits so the auto-end / rate-limit paths run in seconds
process.env.DROPIN_EMPTY_TTL_MS ||= "1500";
process.env.DROPIN_MAX_PER_10MIN ||= "4";
// fake LiveKit credentials: join tokens are signed locally (no SFU needed); server-side calls fail quietly
process.env.LIVEKIT_URL ||= "ws://127.0.0.1:9";
process.env.LIVEKIT_API_KEY ||= "devkey";
process.env.LIVEKIT_API_SECRET ||= "invites-test-secret-0123456789abcdef";
