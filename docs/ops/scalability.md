# Scalability: what's single-instance today, and how to go multi-instance

## Single-instance-only state (in process memory)
| State | Where | Impact with 2+ replicas |
|---|---|---|
| All reads (users, follows, DMs, sessions) | `store.ts` maps, Postgres is a write-behind snapshot | each replica serves its own copy; writes from A invisible to B until restart; snapshot saves from two replicas fight (last-writer deletes rows the other added) |
| Live rooms: participants, hands, podium, room chat, reactions | `store.ts` | a room exists only on the replica that created it |
| Presence (online / last seen) | `presence.ts` | users on another replica look offline |
| WebSocket fan-out (`user:<id>`, `room:<id>`, presence channels) | `ws.ts` `WsHub.channels` | DMs / room events don't reach sockets on other replicas |
| OTP codes, signup tickets, rate-limit buckets | `otp.ts`, `realtime.ts`, `httpsec.ts` | verify/register must hit the same replica |

`numReplicas: 1` stays in `railway.json`. Measured headroom on one instance (see REPORT): 1000 sockets, DM fan-out p95 ~136 ms.

## Design to go multi-instance
The blocker is not fan-out but **the write-behind snapshot**: `PgPersistence.save()` diffs against what *this* process
last wrote and deletes rows it doesn't know. Two replicas would delete each other's rows. Order of work:

1. **Row-level writes instead of snapshots** — `sendDm` → `INSERT ... ON CONFLICT (from_id, client_id) DO NOTHING`
   (make `dms_client_idx` UNIQUE after de-duplicating), follows/sessions/users as individual upserts; no deletes from diffs.
   Reads for DMs/sessions go to Postgres (indexes from migration 008 cover them) with a small LRU.
2. **Cross-instance fan-out** — a `Bus` interface used by `WsHub` for channel emits:
   - *Postgres LISTEN/NOTIFY* (no new infra): `NOTIFY ol_fanout, '<json>'` per event, payload ≤ 8 KB (send ids, not
     bodies, for DMs > 7 KB), one dedicated `LISTEN` connection per replica (not from the pool), reconnect + resubscribe
     on error, and a catch-up path (clients already call `dm:since` after reconnect). Fine to ~1–2k events/s.
   - *Redis pub/sub* — a Redis service already exists in the Railway project (`redis:8.2`, currently unused by the app).
     Better for higher volume and for shared presence (`HSET presence:<user> <conn> <ts>` + TTL) and rate-limit buckets.
   Each replica publishes every channel emit with its instance id and delivers messages from other instances to its
   local sockets (skip its own).
3. **Rooms**: pin a live room to one replica (room owner) and proxy participants through the bus, or move room state to Redis.
4. **OTP / tickets / rate limits** → Redis with TTL.
5. Then `numReplicas: 2`; LiveKit is already external and multi-instance safe.

**LISTEN/NOTIFY fan-out was deliberately NOT implemented behind a flag in this pass**: with the snapshot persistence of
step 1 still in place, enabling a second replica would corrupt data regardless of fan-out, so a flag would be a foot-gun
rather than a stepping stone. Step 1 is the prerequisite and is a larger change that overlaps every feature branch.
