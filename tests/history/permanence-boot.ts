// Child process for permanence.test.ts: a FRESH server boot against the same Postgres (= a restart / redeploy),
// then reports what history a client would get. Args: JSON { a, b, dmKey, gid, roomId }.
import { store } from "../../server/store";
import { pageBefore } from "../../server/chat/paging";

const { a, b, dmKey, gid, roomId } = JSON.parse(process.argv[2]);
void (async () => {
await store.init();
const walk = <T extends { id: string; createdAt: number }>(get: (beforeId?: string) => { messages: T[]; hasMore: boolean }) => {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 1000; n++) {
    const p = get(cursor);
    all.unshift(...p.messages);
    if (!p.hasMore || !p.messages.length) break;
    cursor = p.messages[0].id;
  }
  return all;
};
const dmA = walk((beforeId) => store.dmHistory(a, b, { beforeId, limit: 200 }) as never);
const dmB = walk((beforeId) => store.dmHistory(b, a, { beforeId, limit: 200 }) as never);
const grp = walk((beforeId) => pageBefore(store.dms.get(gid) ?? [], { beforeId, limit: 200 }));
const room = walk((beforeId) => {
  const r = store.chatPage(a, roomId, { beforeId, limit: 200 });
  return r.ok ? r : { messages: [], hasMore: false };
});
const sum = (l0: unknown[]) => { const l = l0 as { id: string; text: string; deleted?: boolean }[]; return { n: l.length, first: l[0]?.text, deleted: l.filter((m) => m.deleted).map((m) => m.id), texts: Object.fromEntries(l.filter((m) => m.deleted).map((m) => [m.id, m.text])) }; };
console.log("RESULT " + JSON.stringify({ dmA: sum(dmA), dmB: sum(dmB), group: sum(grp), room: sum(room), dmKeyLen: store.dms.get(dmKey)?.length ?? 0 }));
await store.close();
process.exit(0);
})();
