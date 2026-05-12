const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { hasAnyUser } = require('../auth');

const router = express.Router();

// --- First-run setup ---------------------------------------------------------
// Kalau belum ada user sama sekali, tampilkan form signup. Setelah user pertama
// dibuat, route ini otomatis redirect ke /login.

router.get('/setup', (req, res) => {
  if (hasAnyUser()) return res.redirect('/login');
  res.render('setup', { error: null, username: '' });
});

router.post('/setup', (req, res) => {
  if (hasAnyUser()) return res.redirect('/login');

  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const confirm = req.body.confirm || '';

  const renderErr = (msg) => res.status(400).render('setup', { error: msg, username });

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

router.post('/login', (req, res) => {
  if (!hasAnyUser()) return res.redirect('/setup');
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).render('login', { error: 'Invalid username or password.' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
