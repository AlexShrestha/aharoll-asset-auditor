import crypto from 'node:crypto';

const COOKIE_NAME = 'aharoll_admin_session';

function getSessionValue() {
  const key = process.env.ADMIN_DASHBOARD_KEY;
  if (!key) throw new Error('ADMIN_DASHBOARD_KEY not configured');
  return crypto.createHmac('sha256', key).update('aharoll-admin').digest('hex');
}

function parseCookies(header) {
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rawValue.join('=') || '');
    return acc;
  }, {});
}

export function isAdminAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  try {
    return cookies[COOKIE_NAME] === getSessionValue();
  } catch {
    return false;
  }
}

export function requireAdminSession(req, res) {
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function createAdminSessionHeaders() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return {
    'Set-Cookie': `${COOKIE_NAME}=${getSessionValue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`,
  };
}

export function clearAdminSessionHeaders() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  };
}

export function verifyAdminKey(key) {
  const expected = process.env.ADMIN_DASHBOARD_KEY;
  if (!expected) throw new Error('ADMIN_DASHBOARD_KEY not configured');
  return key && key === expected;
}
