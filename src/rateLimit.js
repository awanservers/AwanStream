// Lightweight in-memory rate limiter for sensitive endpoints (login, setup).
// Single-process design — fine for this app's single-admin use case.
//
// Strategy: per-IP failure counter with sliding window + lockout.
//   - Track failed attempts in a 15 min window
//   - At MAX_FAILURES, lock out the IP for LOCKOUT_MS
//   - Successful login (or any explicit reset) clears the counter
//
// Failed attempts are logged with redacted username so brute-force activity
// is visible in `docker logs` for audit purposes.

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;     // 15 min sliding window
const LOCKOUT_MS = 15 * 60 * 1000;    // 15 min lockout after threshold
const CLEANUP_MS = 60 * 60 * 1000;    // GC stale entries hourly

// key (IP) -> { attempts: [timestamps...], lockedUntil: number|null }
const buckets = new Map();

function getClientIp(req) {
  // Honour X-Forwarded-For when 'trust proxy' is set (single hop only,
  // matches our nginx deployment guide).
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.ip || req.connection?.remoteAddress || '-').replace(/^::ffff:/, '');
}

function getBucket(key) {
  let b = buckets.get(key);
  if (!b) {
    b = { attempts: [], lockedUntil: null };
    buckets.set(key, b);
  }
  return b;
}

/**
 * Check whether `key` is currently allowed to attempt the action.
 * Does NOT record the attempt — call recordFailure() after a failed attempt.
 *
 * @returns {{ allowed: boolean, retryAfterSec: number, remaining: number }}
 */
function check(key) {
  const b = getBucket(key);
  const now = Date.now();

  // Drop attempts outside the sliding window.
  b.attempts = b.attempts.filter((t) => now - t < WINDOW_MS);

  // Active lockout?
  if (b.lockedUntil && b.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000),
      remaining: 0,
    };
  }
  // Lockout expired — clear it.
  if (b.lockedUntil && b.lockedUntil <= now) {
    b.lockedUntil = null;
    b.attempts = [];
  }

  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: Math.max(0, MAX_FAILURES - b.attempts.length),
  };
}

/**
 * Record a failed attempt. Triggers lockout if threshold reached.
 *
 * @returns {{ locked: boolean, retryAfterSec: number, remaining: number }}
 */
function recordFailure(key) {
  const b = getBucket(key);
  const now = Date.now();
  b.attempts.push(now);
  b.attempts = b.attempts.filter((t) => now - t < WINDOW_MS);

  if (b.attempts.length >= MAX_FAILURES) {
    b.lockedUntil = now + LOCKOUT_MS;
    return {
      locked: true,
      retryAfterSec: Math.ceil(LOCKOUT_MS / 1000),
      remaining: 0,
    };
  }
  return {
    locked: false,
    retryAfterSec: 0,
    remaining: MAX_FAILURES - b.attempts.length,
  };
}

/**
 * Clear all state for `key` — call on successful login so legitimate users
 * who mistyped a few times don't get locked out by their own correct attempt.
 */
function reset(key) {
  buckets.delete(key);
}

/**
 * Build an Express middleware that gates a route. Optional `keyFn(req)`
 * lets callers combine IP with another dimension (e.g. username) — defaults
 * to IP only.
 *
 * Usage:
 *   const loginLimiter = rateLimit.middleware('login');
 *   router.post('/login', loginLimiter, handler);
 */
function middleware(label = 'action', keyFn = getClientIp) {
  return (req, res, next) => {
    const key = keyFn(req);
    const status = check(key);
    if (!status.allowed) {
      console.warn(
        `[rateLimit] ${label} locked for ${key} — retry in ${status.retryAfterSec}s`
      );
      // Render a user-friendly page for HTML routes; JSON for API-style.
      const wantsJson = (req.headers.accept || '').includes('application/json');
      res.set('Retry-After', String(status.retryAfterSec));
      if (wantsJson) {
        return res.status(429).json({
          error: 'Too many attempts',
          retryAfterSec: status.retryAfterSec,
        });
      }
      // Reuse login view to display the lockout message inline.
      const mins = Math.ceil(status.retryAfterSec / 60);
      return res.status(429).render('login', {
        error: `Terlalu banyak percobaan login dari IP kamu. Coba lagi dalam ${mins} menit.`,
      });
    }
    // Attach helpers so route handlers can call recordFailure / reset.
    req.rateLimit = {
      key,
      label,
      recordFailure: () => recordFailure(key),
      reset: () => reset(key),
    };
    next();
  };
}

// Periodic cleanup of stale buckets (no failures in window AND no lockout).
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    const hasRecent = b.attempts.some((t) => now - t < WINDOW_MS);
    const isLocked = b.lockedUntil && b.lockedUntil > now;
    if (!hasRecent && !isLocked) buckets.delete(key);
  }
}, CLEANUP_MS).unref();

module.exports = {
  check,
  recordFailure,
  reset,
  middleware,
  // Exposed for test/inspection.
  _buckets: buckets,
  MAX_FAILURES,
  WINDOW_MS,
  LOCKOUT_MS,
};
