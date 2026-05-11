// Generate a random SESSION_SECRET and write it to .env
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const samplePath = path.join(__dirname, '.env.example');

const secret = crypto.randomBytes(48).toString('hex');

let content = '';
if (fs.existsSync(envPath)) {
  content = fs.readFileSync(envPath, 'utf8');
  if (/^SESSION_SECRET=.*/m.test(content)) {
    content = content.replace(/^SESSION_SECRET=.*/m, `SESSION_SECRET=${secret}`);
  } else {
    content += `\nSESSION_SECRET=${secret}\n`;
  }
} else if (fs.existsSync(samplePath)) {
  content = fs.readFileSync(samplePath, 'utf8')
    .replace(/^SESSION_SECRET=.*/m, `SESSION_SECRET=${secret}`);
} else {
  content = `PORT=7575\nSESSION_SECRET=${secret}\nNODE_ENV=development\n`;
}

fs.writeFileSync(envPath, content);
console.log('✓ .env written with a fresh SESSION_SECRET.');
