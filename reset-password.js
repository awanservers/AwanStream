// Reset / create the admin user. Usage: node reset-password.js
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { db, ensureSchema } = require('./src/db');

ensureSchema();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

(async () => {
  const username = (await ask('Username [admin]: ')).trim() || 'admin';
  const password = (await ask('New password: ')).trim();
  rl.close();

  if (!password) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    console.log(`✓ Password updated for user "${username}".`);
  } else {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`✓ User "${username}" created.`);
  }
})();
