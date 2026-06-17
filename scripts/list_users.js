const Database = require('better-sqlite3');
const db = new Database('db/awanstream.db');
console.log(db.prepare('SELECT id, username, password_hash FROM users').all());
