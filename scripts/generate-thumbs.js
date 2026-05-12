/**
 * One-shot script: generate thumbnails for all videos.
 * Usage:
 *   node scripts/generate-thumbs.js          # skip videos that already have thumbnail
 *   node scripts/generate-thumbs.js --force  # regenerate all (use after changing thumbnail size)
 */
const path = require('path');
const fs = require('fs');
const { db, ensureSchema } = require('../src/db');
const transcoder = require('../src/transcoder');

ensureSchema();

const force = process.argv.includes('--force');
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const videos = db.prepare("SELECT id, filename, thumbnail FROM videos").all();

let generated = 0;
let skipped = 0;
let failed = 0;

for (const v of videos) {
  if (v.thumbnail && !force) {
    // Check if file actually exists.
    const thumbPath = path.join(uploadDir, 'thumbs', v.thumbnail);
    if (fs.existsSync(thumbPath)) {
      skipped++;
      continue;
    }
  }

  const videoPath = path.join(uploadDir, v.filename);
  if (!fs.existsSync(videoPath)) {
    console.log(`SKIP id=${v.id} — file not found: ${v.filename}`);
    skipped++;
    continue;
  }

  const thumb = transcoder.generateThumbnail(videoPath, v.id);
  if (thumb) {
    db.prepare('UPDATE videos SET thumbnail=? WHERE id=?').run(thumb, v.id);
    console.log(`OK id=${v.id} — ${thumb}`);
    generated++;
  } else {
    console.log(`FAIL id=${v.id} — could not generate thumbnail`);
    failed++;
  }
}

console.log(`\nDone: ${generated} generated, ${skipped} skipped, ${failed} failed`);
