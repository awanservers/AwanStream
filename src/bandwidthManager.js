// Read monthly bandwidth totals from vnStat.
// vnStat keeps network accounting outside this app, so totals survive app restarts.
const { spawnSync } = require('child_process');

const CACHE_MS = 60 * 1000;
let cached = null;
let cachedAt = 0;

function currentMonthParts() {
  const tz = process.env.TZ || 'Asia/Jakarta';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date()).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = Number(p.value);
      return acc;
    }, {});
    return { year: parts.year, month: parts.month };
  } catch (_) {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
}

function toBytes(value, multiplier) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * multiplier);
}

function trafficUnitMultiplier(data) {
  // vnStat 2.x JSON reports bytes. Older JSON API v1 reports KiB.
  const jsonVersion = Number(data && data.jsonversion);
  return jsonVersion && jsonVersion < 2 ? 1024 : 1;
}

function monthRows(iface) {
  const traffic = iface && iface.traffic;
  if (!traffic) return [];
  if (Array.isArray(traffic.month)) return traffic.month;
  if (Array.isArray(traffic.months)) return traffic.months;
  return [];
}

function parseVnstatJson(data) {
  const interfaces = Array.isArray(data && data.interfaces) ? data.interfaces : [];
  if (interfaces.length === 0) {
    return unavailable('vnStat has no monitored interfaces yet');
  }

  const wanted = String(process.env.VNSTAT_INTERFACE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wantedSet = new Set(wanted);
  const { year, month } = currentMonthParts();
  const multiplier = trafficUnitMultiplier(data);

  let rxBytes = 0;
  let txBytes = 0;
  let matchedInterfaces = 0;

  for (const iface of interfaces) {
    const name = iface.name || iface.id || iface.nick || '';
    if (name === 'lo') continue;
    if (wantedSet.size > 0 && !wantedSet.has(name)) continue;

    const rows = monthRows(iface);
    const row = rows.find((r) => r && r.date && r.date.year === year && r.date.month === month);
    if (!row) continue;

    rxBytes += toBytes(row.rx, multiplier);
    txBytes += toBytes(row.tx, multiplier);
    matchedInterfaces++;
  }

  if (wantedSet.size > 0 && matchedInterfaces === 0) {
    return unavailable(`vnStat interface not found for current month: ${wanted.join(', ')}`);
  }

  return {
    available: true,
    source: 'vnstat',
    month,
    year,
    rxBytes,
    txBytes,
    totalBytes: rxBytes + txBytes,
    interfaces: matchedInterfaces,
    updatedAt: new Date().toISOString(),
  };
}

function unavailable(error) {
  return {
    available: false,
    source: 'vnstat',
    error,
    rxBytes: 0,
    txBytes: 0,
    totalBytes: 0,
    updatedAt: new Date().toISOString(),
  };
}

function readMonthlyUsage() {
  const r = spawnSync('vnstat', ['--json'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });

  if (r.error) {
    return unavailable(r.error.code === 'ENOENT'
      ? 'vnStat is not installed'
      : r.error.message);
  }
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || '').trim();
    return unavailable(msg || `vnStat exited with code ${r.status}`);
  }

  try {
    return parseVnstatJson(JSON.parse(r.stdout));
  } catch (e) {
    return unavailable('Failed to parse vnStat JSON: ' + e.message);
  }
}

function getMonthlyUsage(opts = {}) {
  const now = Date.now();
  if (!opts.force && cached && now - cachedAt < CACHE_MS) return cached;
  cached = readMonthlyUsage();
  cachedAt = now;
  return cached;
}

module.exports = {
  getMonthlyUsage,
  parseVnstatJson,
  currentMonthParts,
};
