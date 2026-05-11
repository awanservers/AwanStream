// Test codec validation against all uploaded mp4 files.
const fs = require('fs');
const path = require('path');
const t = require('../src/transcoder');
const dir = path.join(__dirname, '..', 'public', 'uploads');
const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|mov|flv|ts|webm)$/i.test(f));
if (files.length === 0) { console.log('No video files found.'); process.exit(0); }
for (const f of files) {
  const r = t.validateCodec(path.join(dir, f));
  console.log(r.ok ? 'OK  ' : 'FAIL', f.slice(0, 50).padEnd(52), r.ok ? `(${r.info.videoCodec}/${r.info.audioCodec})` : r.issues.join('; '));
}
