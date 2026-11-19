-- Durable Open Lounge call links (Donny t6082u): a link stays joinable across backend restarts and redeploys.
-- Only who the link is for and when it was made; no tokens, keys, signaling or media state. Additive.
CREATE TABLE IF NOT EXISTS call_links (
 id text PRIMARY KEY,
 caller_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 callee_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at bigint NOT NULL
);
