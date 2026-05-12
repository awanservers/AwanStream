const { db } = require('./db');

function hasAnyUser() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return row.n > 0;
}

function requireAuth(req, res, next) {
  // First-run: no admin exists yet → force user ke /setup
  if (!hasAnyUser()) {
    if (req.accepts('html')) return res.redirect('/setup');
    return res.status(401).json({ error: 'setup required' });
  }
  if (req.session && req.session.userId) return next();
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'unauthorized' });
}

function injectUser(req, res, next) {
  res.locals.currentUser = req.session && req.session.username
    ? { id: req.session.userId, username: req.session.username }
    : null;
  next();
}

module.exports = { requireAuth, injectUser, hasAnyUser };
