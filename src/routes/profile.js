// Profile management — view & edit own account, change password.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();

// Validate username format. Same rules as /setup.
function validateUsername(name) {
  if (!name || name.length < 3) return 'Username minimal 3 karakter.';
  if (name.length > 32) return 'Username maksimal 32 karakter.';
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return 'Username hanya boleh huruf, angka, _ . -';
  }
  return null;
}

router.get('/', (req, res) => {
  const user = db.prepare(
    'SELECT id, username, created_at FROM users WHERE id=?'
  ).get(req.session.userId);
  if (!user) return res.redirect('/logout');
  res.render('profile', {
    user,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Update own username.
router.post('/', (req, res) => {
  const newUsername = (req.body.username || '').trim();
  const err = validateUsername(newUsername);
  if (err) {
    return res.redirect('/profile?error=' + encodeURIComponent(err));
  }
  // No-op if unchanged.
  const current = db.prepare('SELECT username FROM users WHERE id=?').get(req.session.userId);
  if (!current) return res.redirect('/logout');
  if (current.username === newUsername) {
    return res.redirect('/profile?notice=Tidak+ada+perubahan');
  }
  // Check uniqueness.
  const taken = db.prepare(
    'SELECT 1 FROM users WHERE username=? AND id<>?'
  ).get(newUsername, req.session.userId);
  if (taken) {
    return res.redirect('/profile?error=' + encodeURIComponent('Username sudah dipakai user lain.'));
  }
  db.prepare('UPDATE users SET username=? WHERE id=?').run(newUsername, req.session.userId);
  // Sync session so the sidebar / header updates immediately.
  req.session.username = newUsername;
  res.redirect('/profile?notice=' + encodeURIComponent('Username diperbarui.'));
});

// Change own password — must verify current password.
router.post('/password', (req, res) => {
  const current = req.body.current_password || '';
  const next = req.body.new_password || '';
  const confirm = req.body.confirm_password || '';

  const back = (msg, isError = false) =>
    res.redirect('/profile?' + (isError ? 'error=' : 'notice=') + encodeURIComponent(msg));

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

module.exports = router;
