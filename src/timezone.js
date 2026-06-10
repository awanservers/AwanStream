// Timezone helpers shared by schedule-related routes.

// Parse a "YYYY-MM-DDTHH:MM" value from <input type="datetime-local"> into a
// UTC ISO string, interpreting the local time in the given IANA timezone.
function parseLocalToUTC(localStr, tz) {
  if (!localStr) return null;
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

module.exports = { parseLocalToUTC };
