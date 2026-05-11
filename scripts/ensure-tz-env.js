// Ensure .env has TZ and TZ_LABEL keys (default Asia/Jakarta / WIB) without
// touching any other existing values.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.error('No .env found. Run `node generate-secret.js` first.');
  process.exit(1);
}

let content = fs.readFileSync(envPath, 'utf8');
let changed = false;

function ensure(key, def) {
  if (!new RegExp(`^${key}=`, 'm').test(content)) {
    if (!content.endsWith('\n')) content += '\n';
    content += `${key}=${def}\n`;
    changed = true;
  }
}

ensure('TZ', 'Asia/Jakarta');
ensure('TZ_LABEL', 'WIB');

if (changed) {
  fs.writeFileSync(envPath, content);
  console.log('✓ Added missing TZ / TZ_LABEL to .env');
} else {
  console.log('✓ TZ / TZ_LABEL already present in .env');
}
