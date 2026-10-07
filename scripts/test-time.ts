// Time formatting / skew tests for src/lib/time.ts. Run per zone, e.g.
//   TZ=Asia/Kolkata npx tsx scripts/test-time.ts      (or: npm run test:time → all zones)
import { dayDiff, formatAgo, formatClock, formatDaySeparator, formatListTime, formatFull, recordClockSample, serverNow, clockInfo } from "../src/lib/time";

const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
let fails = 0, passes = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passes++ : fails++;
  console.log(`${ok ? "✓" : "✗"} [${zone}] ${label}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const Z = (iso: string) => Date.parse(iso);
const nb = (s: string) => s.replace(/[\u202f\u00a0]/g, " "); // ICU uses narrow no-break spaces before AM/PM

const cases: Record<string, () => void> = {
  "America/Phoenix": () => {
    const now = Z("2026-10-07T04:30:00Z"); // Tue Oct 6, 9:30 PM MST
    eq(nb(formatListTime(Z("2026-10-07T04:24:00Z"), now)), "9:24 PM", "today → time");
    eq(formatListTime(Z("2026-10-06T06:59:00Z"), now), "Yesterday", "yesterday 11:59 PM → Yesterday");
    eq(formatListTime(Z("2026-10-01T19:00:00Z"), now), "Thu", "within 7 days → weekday");
    eq(formatListTime(Z("2026-09-28T19:00:00Z"), now), "Sep 28", "older → date");
    eq(formatListTime(Z("2025-12-31T19:00:00Z"), now), "Dec 31, 2025", "other year → date + year");
    eq(formatDaySeparator(Z("2026-10-07T04:24:00Z"), now), "Today", "separator today");
    eq(formatDaySeparator(Z("2026-10-03T19:00:00Z"), now), "Saturday", "separator weekday");
    eq(formatDaySeparator(Z("2026-09-01T19:00:00Z"), now), "September 1", "separator older");
    // midnight rollover: 11:59:30 PM → 12:00:30 AM
    const late = Z("2026-10-07T06:59:30Z"), after = Z("2026-10-07T07:00:30Z");
    eq([dayDiff(late, Z("2026-10-07T06:59:59Z")), dayDiff(late, after)], [0, 1], "midnight rollover flips today → yesterday");
    eq([formatListTime(late, after), formatAgo(late, after)], ["Yesterday", "1m"], "…list says Yesterday, relative says 1m");
    // same instant pair that crosses midnight in Kolkata is the same day here
    eq(dayDiff(Z("2026-10-06T18:29:00Z"), Z("2026-10-06T18:31:00Z")), 0, "18:29Z/18:31Z same day in Phoenix");
    eq(nb(formatFull(Z("2026-10-07T04:24:05Z"))), "Tue, Oct 6, 2026, 9:24:05 PM MST · 2026-10-07 04:24 UTC", "full local + UTC");
  },
  "Asia/Kolkata": () => {
    eq(dayDiff(Z("2026-10-06T18:29:00Z"), Z("2026-10-06T18:31:00Z")), 1, "23:59 IST → 00:01 IST is a new day");
    eq(formatListTime(Z("2026-10-06T18:29:00Z"), Z("2026-10-06T18:31:00Z")), "Yesterday", "…so it reads Yesterday");
    eq(nb(formatClock(Z("2026-10-06T18:29:00Z"))), "11:59 PM", "+5:30 offset applied");
  },
  "Europe/London": () => {
    // DST ends 2026-10-25 01:00Z (BST → GMT)
    eq(nb(formatClock(Z("2026-10-24T22:30:00Z"))), "11:30 PM", "BST evening");
    eq(formatListTime(Z("2026-10-24T22:30:00Z"), Z("2026-10-25T09:00:00Z")), "Yesterday", "across fall-back: yesterday");
    eq([nb(formatClock(Z("2026-10-25T00:30:00Z"))), nb(formatClock(Z("2026-10-25T01:30:00Z")))], ["1:30 AM", "1:30 AM"], "repeated 1:30 AM hour shows both correctly");
    eq(dayDiff(Z("2026-10-25T00:30:00Z"), Z("2026-10-25T23:30:00Z")), 0, "25-hour day is one day");
    // DST starts 2026-03-29 01:00Z (GMT → BST): 23-hour day
    eq(dayDiff(Z("2026-03-28T23:30:00Z"), Z("2026-03-29T23:30:00Z")), 2, "across spring-forward: 23:30 GMT Sat → 00:30 BST Mon = 2 days");
    eq(dayDiff(Z("2026-03-29T00:30:00Z"), Z("2026-03-29T22:59:00Z")), 0, "23-hour day is one day");
    eq(nb(formatFull(Z("2026-10-25T01:30:00Z"))).includes("GMT") && nb(formatFull(Z("2026-10-25T00:30:00Z"))).includes("BST") || nb(formatFull(Z("2026-10-25T00:30:00Z"))).includes("GMT+1"), true, "full stamp names the right zone on each side");
  },
  "Pacific/Chatham": () => {
    // +13:45 in DST (from 2026-09-27)
    eq(nb(formatClock(Z("2026-10-06T10:00:00Z"))), "11:45 PM", "+13:45 offset applied");
    eq(formatListTime(Z("2026-10-06T10:00:00Z"), Z("2026-10-06T10:20:00Z")), "Yesterday", "23:45 → 00:05 next day");
    eq(nb(formatListTime(Z("2026-10-06T10:20:00Z"), Z("2026-10-06T10:30:00Z"))), "12:05 AM", "today after midnight → time");
  },
};

// zone-specific cases (en-US); H24=1 → a 24-hour locale run instead
if (process.env.H24 === "1") {
  eq(formatClock(Z("2026-10-07T04:24:00Z")), zone === "America/Phoenix" ? "21:24" : formatClock(Z("2026-10-07T04:24:00Z")), "24-hour locale respected (en-GB → 21:24)");
  eq(formatListTime(Z("2026-10-06T06:59:00Z"), Z("2026-10-07T04:30:00Z")), "Yesterday", "24-hour locale: Yesterday");
} else (cases[zone] ?? (() => console.log(`(no zone-specific cases for ${zone})`)))();

// zone-independent: relative times and skew correction
const now = Z("2026-10-07T04:30:00Z");
eq([formatAgo(now - 30_000, now), formatAgo(now - 5 * 60_000, now), formatAgo(now - 3 * 3_600_000, now), formatAgo(now - 2 * 86_400_000, now)], ["just now", "5m", "3h", "2d"], "relative: just now / 5m / 3h / 2d");
eq(formatAgo(now + 9 * 60_000, now), "just now", "a stamp from the future (skew) reads just now, never negative");
// phone clock 10 min slow: server = local + 600 000
const t0 = Date.now();
recordClockSample(t0, t0 + 600_000 + 40, t0 + 80);
eq(Math.round(clockInfo().offset / 1000), 600, "skew +10 min estimated from one ping");
eq(Math.round((serverNow() - Date.now()) / 1000), 600, "serverNow() = device clock + 10 min");
recordClockSample(t0, t0 + 600_000 + 3_000, t0 + 4_000); // high-RTT, noisy sample → ignored (min-RTT wins)
eq(Math.round(clockInfo().offset / 1000), 600, "noisy high-RTT sample doesn't move it");
const msgAt = serverNow() - 20_000; // server says the message is 20 s old
eq(formatAgo(msgAt), "just now", "…so a 20 s old message still reads 'just now' on the slow phone");
eq(formatAgo(serverNow() - 120_000), "2m", "…and 2 min old reads 2m");
// phone clock 10 min fast after the user fixes it: big jump adopted immediately
const t1 = Date.now();
for (let i = 0; i < 8; i++) recordClockSample(t1, t1 - 600_000 + 20, t1 + 40);
eq(Math.round(clockInfo().offset / 1000), -600, "skew −10 min (fast phone) adopted after a jump");
eq(formatAgo(serverNow() - 30_000), "just now", "fast phone: 30 s old message reads just now (not '10m')");

console.log(fails ? `FAILED ${fails} / passed ${passes} [${zone}]` : `ALL PASSED ${passes} [${zone}]`);
process.exit(fails ? 1 : 0);
