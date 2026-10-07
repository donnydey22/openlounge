#!/usr/bin/env node
// READ-ONLY: list accounts created via Google/Apple recently (default: last 24h) with their data counts, to spot an
// empty duplicate made when a phone member signed in with Google/Apple before linking existed.
// Changes nothing: runs inside a READ ONLY transaction that is always rolled back.
//
//   DATABASE_URL=postgres://… node scripts/find-dup-accounts.mjs [--hours 24] [--json]
//
// An account is "empty" (eligible for the automatic move in the link step) when it has no phone, no other sign-in
// method, no DMs, no rooms and no follows in either direction, and is under 7 days old.

import pg from "pg";

const args = process.argv.slice(2);
const hoursArg = args.indexOf("--hours");
const hours = hoursArg >= 0 ? Number(args[hoursArg + 1]) : 24;
const asJson = args.includes("--json");
if (!Number.isFinite(hours) || hours <= 0) {
  console.error("--hours must be a positive number");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (read-only use; nothing is modified).");
  process.exit(2);
}

const since = Date.now() - hours * 3600_000;
const mask = (e) => {
  if (!e) return "";
  const [l, d] = String(e).split("@");
  return d ? `${l.slice(0, 2)}•••@${d}` : "•••";
};

const client = new pg.Client({ connectionString: url, ssl: /sslmode=require|railway|rlwy/i.test(url) ? { rejectUnauthorized: false } : undefined });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(
    `WITH firsts AS (
       SELECT DISTINCT ON (user_id) user_id, provider, email
         FROM auth_identities ORDER BY user_id, created_at, provider
     )
     SELECT u.id, u.username, u.name, u.created_at, (u.phone IS NOT NULL) AS has_phone,
            f.provider AS created_via, f.email,
            (SELECT string_agg(provider, ',' ORDER BY provider) FROM auth_identities a WHERE a.user_id = u.id) AS methods,
            (SELECT count(*) FROM dms d WHERE d.from_id = u.id OR d.to_id = u.id)::int AS dms,
            (SELECT count(*) FROM rooms r WHERE r.host_id = u.id)::int AS rooms_hosted,
            (SELECT count(*) FROM follows x WHERE x.follower_id = u.id)::int AS following,
            (SELECT count(*) FROM follows x WHERE x.followee_id = u.id)::int AS followers
       FROM users u JOIN firsts f ON f.user_id = u.id
      WHERE f.provider IN ('google', 'apple') AND u.created_at >= $1
      ORDER BY u.created_at DESC`,
    [since],
  );
  const out = rows.map((r) => {
    const methods = (r.methods ?? "").split(",").filter(Boolean);
    const empty = !r.has_phone && methods.length === 1 && !r.dms && !r.rooms_hosted && !r.following && !r.followers;
    return {
      id: r.id,
      username: r.username,
      name: r.name,
      createdAt: new Date(Number(r.created_at)).toLocaleString("en-US", { timeZone: "America/Phoenix" }) + " MST",
      createdVia: r.created_via,
      email: mask(r.email),
      methods: methods.join("+"),
      hasPhone: r.has_phone,
      dms: r.dms,
      roomsHosted: r.rooms_hosted,
      following: r.following,
      followers: r.followers,
      emptyDuplicateCandidate: empty,
    };
  });
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Accounts created via Google/Apple in the last ${hours}h: ${out.length} (read-only, nothing changed)`);
    if (out.length) console.table(out);
  }
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
