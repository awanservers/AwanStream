// One-shot fix: reset any pre-existing video row that was auto-labelled 'ready'
// during the migration. Those files were never actually transcoded by
// Prepare, so their real state is 'uploaded'.
const { db, ensureSchema } = require('../src/db');
ensureSchema();

const result = db.prepare(`UPDATE videos
  SET status='uploaded'
  WHERE status='ready'`).run();

console.log(`Reset ${result.changes} video(s) back to status 'uploaded'.`);
