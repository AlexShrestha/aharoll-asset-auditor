// Minimal fixed-window, in-memory rate limiter keyed by client IP.
//
// HONEST LIMITATION: state lives in the memory of one function instance. On serverless (Vercel) every cold
// start or parallel instance has its own counters, so this is best-effort abuse damping, not a guarantee.
// A hard limit needs a shared store (Redis/KV/DB) or a platform firewall rule.

const buckets = new Map();
const MAX_TRACKED_KEYS = 5000;

// Client IP: first address of x-forwarded-for only (later entries are client-controlled / proxy chain),
// else the socket address, else 'unknown'.
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const first = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  return first || req.socket?.remoteAddress || 'unknown';
}

// Returns { allowed, retryAfterSec }. Counts the call when allowed.
export function checkRateLimit(key, { limit, windowMs, now = Date.now() }) {
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
      if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear(); // memory bound beats precision
    }
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}
