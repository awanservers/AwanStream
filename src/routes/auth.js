const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { hasAnyUser } = require('../auth');
const rateLimit = require('../rateLimit');

const router = express.Router();

// Rate limiters: protect login + setup from brute-force.
// 5 failures per IP within 15 min → 15 min lockout.
const loginLimiter = rateLimit.middleware('login');
const setupLimiter = rateLimit.middleware('setup');

// --- First-run setup ---------------------------------------------------------
// Kalau belum ada user sama sekali, tampilkan form signup. Setelah user pertama
// dibuat, route ini otomatis redirect ke /login.

router.get('/setup', (req, res) => {
  if (hasAnyUser()) return res.redirect('/login');
  res.render('setup', { error: null, username: '' });
});

router.post('/setup', setupLimiter, (req, res) => {
  if (hasAnyUser()) return res.redirect('/login');

  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const confirm = req.body.confirm || '';

  const renderErr = (msg) => {
    req.rateLimit && req.rateLimit.recordFailure();
    return res.status(400).render('setup', { error: msg, username });
  };

  if (username.length < 3) return renderErr('Username minimal 3 karakter.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return renderErr('Username hanya boleh huruf, angka, _ . -');
  }
  if (password.length < 6) return renderErr('Password minimal 6 karakter.');
  if (password !== confirm) return renderErr('Konfirmasi password tidak cocok.');

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)'
  ).run(username, hash);

  // Successful first-run setup — clear any failed attempts from the form.
  if (req.rateLimit) req.rateLimit.reset();
  req.session.userId = info.lastInsertRowid;
  req.session.username = username;
  res.redirect('/?notice=Admin+user+created');
});

// --- Login / logout ----------------------------------------------------------

router.get('/login', (req, res) => {
  if (!hasAnyUser()) return res.redirect('/setup');
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', loginLimiter, (req, res) => {
  if (!hasAnyUser()) return res.redirect('/setup');
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    const status = req.rateLimit ? req.rateLimit.recordFailure() : null;
    // Audit log: failed attempt with redacted username.
    const safeUser = String(username || '').slice(0, 32).replace(/[^\x20-\x7E]/g, '?');
    console.warn(
      `[auth] failed login from ${req.rateLimit ? req.rateLimit.key : '-'} ` +
      `user="${safeUser}"` +
      (status ? ` (${status.remaining} attempts remaining)` : '')
    );
    let msg = 'Invalid username or password.';
    if (status && status.locked) {
      const mins = Math.ceil(status.retryAfterSec / 60);
      msg = `Terlalu banyak percobaan. IP kamu di-lockout selama ${mins} menit.`;
      res.set('Retry-After', String(status.retryAfterSec));
      return res.status(429).render('login', { error: msg });
    }
    return res.status(401).render('login', { error: msg });
  }
  // Successful login — clear failure counter.
  if (req.rateLimit) req.rateLimit.reset();
  // Track last login for the profile page (non-critical — best effort).
  try {
    const ip = req.rateLimit ? req.rateLimit.key
      : (req.ip || req.connection?.remoteAddress || '-').replace(/^::ffff:/, '');
    db.prepare(`UPDATE users
      SET last_login_at=CURRENT_TIMESTAMP, last_login_ip=?
      WHERE id=?`).run(ip, user.id);
  } catch (_) {}
  req.session.userId = user.id;
  req.session.username = user.username;
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
