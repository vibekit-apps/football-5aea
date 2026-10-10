// Accounts for this app's users (runs in server.js, Node only; no npm packages).
//
// A phone app cannot rely on browser cookies, so a signed-in user holds a
// random session token that the app keeps in secure storage and sends as
// `Authorization: Bearer <token>` (lib/api.ts does this). Only a SHA-256 of
// each token is stored, so a leaked data file does not hand out sessions.
// Passwords use scrypt with a per-user salt.
//
//   const auth = require('./lib/auth');
//   const user = auth.userFor(req);           // null when not signed in
//   if (!user) return json(res, { error: 'Sign in first' }, 401);
const crypto = require('crypto');
const store = require('./store');

const SESSION_DAYS = 180;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name || null, createdAt: u.createdAt });

function issue(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const sessions = store.read('sessions').filter((s) => s.expiresAt > now);
  sessions.push({ hash: hashToken(token), userId: user.id, createdAt: now, expiresAt: now + SESSION_DAYS * 864e5 });
  store.write('sessions', sessions);
  return { token, user: publicUser(user) };
}

/** Create an account and sign it in. Throws an Error whose message is safe to show. */
function signup({ email, password, name }) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Enter a valid email address');
  if (String(password || '').length < 8) throw new Error('Use a password of at least 8 characters');
  const users = store.read('users');
  if (users.some((u) => u.email === e)) throw new Error('An account with that email already exists');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: crypto.randomUUID(), email: e, name: name ? String(name).slice(0, 80) : null, salt, passwordHash: hashPassword(String(password), salt), createdAt: new Date().toISOString() };
  store.write('users', [...users, user]);
  return issue(user);
}

/** Sign in. Throws an Error whose message is safe to show. */
function login({ email, password }) {
  const e = String(email || '').trim().toLowerCase();
  const user = store.read('users').find((u) => u.email === e);
  const given = Buffer.from(hashPassword(String(password || ''), user ? user.salt : 'no-such-user'), 'hex');
  if (!user || !crypto.timingSafeEqual(given, Buffer.from(user.passwordHash, 'hex'))) throw new Error('Wrong email or password');
  return issue(user);
}

function tokenOf(req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

/** The signed-in user for a request, or null. */
function userFor(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const s = store.read('sessions').find((x) => x.hash === hashToken(token) && x.expiresAt > Date.now());
  if (!s) return null;
  const u = store.read('users').find((x) => x.id === s.userId);
  return u ? publicUser(u) : null;
}

/** End the request's session (no-op if there is none). */
function logout(req) {
  const token = tokenOf(req);
  if (!token) return;
  const h = hashToken(token);
  store.write('sessions', store.read('sessions').filter((s) => s.hash !== h));
}

module.exports = { signup, login, logout, userFor };
