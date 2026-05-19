// Clear YouTube account data from DB.
// Use this when the connected Google account is disabled/unavailable
// and the regular /youtube/disconnect endpoint fails.
const { db, ensureSchema } = require('../src/db');
ensureSchema();

const accounts = db.prepare('SELECT id, channel_title FROM youtube_accounts').all();
if (accounts.length === 0) {
  console.log('No YouTube accounts to clear.');
  process.exit(0);
}

console.log('Found accounts:');
accounts.forEach(a => console.log(`  #${a.id} ${a.channel_title || '(unknown)'}`));

db.prepare('DELETE FROM youtube_accounts').run();
console.log('Cleared youtube_accounts table.');

const uploads = db.prepare(`
  SELECT COUNT(*) AS c FROM youtube_uploads WHERE status IN ('pending', 'uploading')
`).get();
if (uploads.c > 0) {
  db.prepare(`UPDATE youtube_uploads SET status='cancelled',
    last_error='Account disconnected — was Google account disabled?'
    WHERE status IN ('pending', 'uploading')`).run();
  console.log(`Marked ${uploads.c} active uploads as cancelled.`);
}

console.log('Done. Restart AwanStream to apply.');
