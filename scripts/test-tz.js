// Sanity check for parseLocalToUTC: "12:00 WIB" should map to "05:00 UTC".
function parseLocalToUTC(localStr, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localStr);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map((v, i) => (i === 0 ? v : Number(v)));
  const guessUTC = Date.UTC(Y, Mo - 1, D, H, Mi, S || 0);
  const tzDate = new Date(guessUTC);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(tzDate).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asIfUTC = Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second);
  const offset = asIfUTC - guessUTC;
  return new Date(guessUTC - offset).toISOString();
}

const cases = [
  { local: '2026-05-11T12:00', tz: 'Asia/Jakarta', expect: '2026-05-11T05:00:00.000Z' },
  { local: '2026-05-11T00:30', tz: 'Asia/Jakarta', expect: '2026-05-10T17:30:00.000Z' },
  { local: '2026-05-11T08:00', tz: 'Asia/Makassar', expect: '2026-05-11T00:00:00.000Z' },
  { local: '2026-05-11T12:00', tz: 'UTC', expect: '2026-05-11T12:00:00.000Z' },
  { local: '2026-05-11T12:00', tz: 'America/New_York', expect: '2026-05-11T16:00:00.000Z' }, // EDT
];

let fail = 0;
for (const c of cases) {
  const got = parseLocalToUTC(c.local, c.tz);
  const ok = got === c.expect;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.tz.padEnd(18)} ${c.local} → ${got}${ok ? '' : `  (expected ${c.expect})`}`);
}
process.exit(fail ? 1 : 0);
