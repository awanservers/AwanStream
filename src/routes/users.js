// User management — list, add, delete, reset-password for other admins.
// All users have equal admin privileges (multi-admin model, no RBAC).
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();

function validateUsername(name) {
  if (!name || name.length < 3) return 'Username minimal 3 karakter.';
  if (name.length > 32) return 'Username maksimal 32 karakter.';
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return 'Username hanya boleh huruf, angka, _ . -';
  }
  return null;
}

router.get('/', (req, res) => {
  const users = db.prepare(
    'SELECT id, username, created_at FROM users ORDER BY created_at ASC'
  ).all();
  const totalUsers = users.length;
  res.render('users', {
    users,
    totalUsers,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Self-service routes — managed inline from the users table ---

// Edit own username.
router.post('/me', (req, res) => {
  const newUsername = (req.body.username || '').trim();
  const back = (msg, isError = false) =>
    res.redirect('/users?' + (isError ? 'error=' : 'notice=') + encodeURIComponent(msg));

  const err = validateUsername(newUsername);
  if (err) return back(err, true);

  const current = db.prepare('SELECT username FROM users WHERE id=?').get(req.session.userId);
  if (!current) return res.redirect('/logout');
  if (current.username === newUsername) return back('Tidak ada perubahan.');

  const taken = db.prepare(
    'SELECT 1 FROM users WHERE username=? AND id<>?'
  ).get(newUsername, req.session.userId);
  if (taken) return back('Username sudah dipakai user lain.', true);

  db.prepare('UPDATE users SET username=? WHERE id=?').run(newUsername, req.session.userId);
  req.session.username = newUsername; // keep sidebar in sync immediately
  return back('Username diperbarui.');
});

// Change own password (must verify current).
router.post('/me/password', (req, res) => {
  const current = req.body.current_password || '';
  const next = req.body.new_password || '';
  const confirm = req.body.confirm_password || '';

  const back = (msg, isError = false) =>
    res.redirect('/users?' + (isError ? 'error=' : 'notice=') + encodeURIComponent(msg));

  if (!current || !next) return back('Isi semua field password.', true);
  if (next.length < 6)   return back('Password baru minimal 6 karakter.', true);
  if (next !== confirm)  return back('Konfirmasi password tidak cocok.', true);
  if (current === next)  return back('Password baru harus berbeda dari yang lama.', true);

  const user = db.prepare(
    'SELECT id, password_hash FROM users WHERE id=?'
  ).get(req.session.userId);
  if (!user) return res.redirect('/logout');

  if (!bcrypt.compareSync(current, user.password_hash)) {
    return back('Password sekarang salah.', true);
  }

  const hash = bcrypt.hashSync(next, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
  return back('Password berhasil diubah.');
});

// --- Admin actions on other users ---

// Create a new admin user.
router.post('/', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const confirm  = req.body.confirm_password || '';

  const back = (msg, isError = false) =>
    res.redirect('/users?' + (isError ? 'error=' : 'notice=') + encodeURIComponent(msg));

  const usernameErr = validateUsername(username);
  if (usernameErr) return back(usernameErr, true);
  if (password.length < 6) return back('Password minimal 6 karakter.', true);
  if (password !== confirm) return back('Konfirmasi password tidak cocok.', true);

  const taken = db.prepare('SELECT 1 FROM users WHERE username=?').get(username);
  if (taken) return back('Username sudah dipakai.', true);

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hash);
  return back(`User '${username}' dibuat.`);
});

// Reset another user's password. We require the acting user to confirm
// their OWN current password — same trust check as changing your own pw.
router.post('/:id/reset-password', (req, res) => {
  const targetId = Number(req.params.id);
  const newPassword = req.body.new_password || '';
  const confirm     = req.body.confirm_password || '';
  const myPassword  = req.body.my_password || '';

  const back = (msg, isError = false) =>
    res.redirect('/users?' + (isError ? 'error=' : 'notice=') + encodeURIComponent(msg));

  if (newPassword.length < 6) return back('Password baru minimal 6 karakter.', true);
  if (newPassword !== confirm) return back('Konfirmasi password tidak cocok.', true);
  if (!myPassword) return back('Konfirmasi password kamu sendiri.', true);

  const me = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.userId);
  if (!me || !bcrypt.compareSync(myPassword, me.password_hash)) {
    return back('Password kamu (untuk konfirmasi) salah.', true);
  }

  const target = db.prepare('SELECT id, username FROM users WHERE id=?').get(targetId);
  if (!target) return back('User tidak ditemukan.', true);

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, targetId);
  return back(`Password '${target.username}' direset.`);
});

// Delete user. Cannot delete yourself or the last remaining user.
router.post('/:id/delete', (req, res) => {
  const targetId = Number(req.params.id);
  const myPassword = req.body.my_password || '';

  const back = (msg, isError = false) =>
    res.redirect('/users?' + (isError ? 'error=' : 'notice=') + encodeURIComponent(msg));

  if (targetId === req.session.userId) {
    return back('Tidak bisa hapus akun sendiri. Logout dulu kalau mau hapus, minta admin lain.', true);
  }

  const me = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.userId);
  if (!me || !bcrypt.compareSync(myPassword, me.password_hash)) {
    return back('Password kamu (untuk konfirmasi) salah.', true);
  }

  const target = db.prepare('SELECT id, username FROM users WHERE id=?').get(targetId);
  if (!target) return back('User tidak ditemukan.', true);

  // Defensive: never let the table go empty.
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (total <= 1) {
    return back('Minimal harus ada 1 admin tersisa.', true);
  }

  db.prepare('DELETE FROM users WHERE id=?').run(targetId);
  return back(`User '${target.username}' dihapus.`);
});

module.exports = router;
