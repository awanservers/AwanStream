function requireAuth(req, res, next) {
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

module.exports = { requireAuth, injectUser };
