const Database = require('better-sqlite3');
const db = new Database('data.db');
const bcrypt = require('bcrypt');

// Buat tabel user jika belum ada
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS wa_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  )
`).run();

// bikin akun
const passwordPlain = 'admin123';
const passwordHashed = bcrypt.hashSync(passwordPlain, 10); // 10 = saltRounds
try {
  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', passwordHashed);
  console.log('✅ Admin dibuat');
} catch (e) {
  console.log('Sudah ada');
}

module.exports = db;
