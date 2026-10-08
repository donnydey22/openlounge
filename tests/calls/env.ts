process.env.TEST_DATABASE_URL ||= "postgresql://ua@127.0.0.1:55433/calls_test";
// short ring timeout / orphan windows so those paths run in seconds
process.env.CALL_RING_TIMEOUT_MS ||= "1500";
process.env.CALL_CALLER_GONE_MS ||= "300";
process.env.CALL_MAX_PER_10MIN ||= "40";
// fake LiveKit credentials: tokens are signed locally (no SFU needed); server-side deletes fail quietly
process.env.LIVEKIT_URL ||= "ws://127.0.0.1:9";
process.env.LIVEKIT_API_KEY ||= "devkey";
process.env.LIVEKIT_API_SECRET ||= "calls-test-secret-0123456789abcdef0";
process.env.CALL_SWEEP_MS ||= "100";
