const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'painel.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bicos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    price REAL DEFAULT 0,
    status TEXT DEFAULT 'aberto',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT,
    plan TEXT,
    credits INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pendente',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    photo TEXT NOT NULL,
    embedding TEXT NOT NULL,
    gender TEXT,
    vehicle TEXT,
    platform TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.all('PRAGMA table_info(faces)', (err, cols) => {
    if (err) return;
    const names = cols.map((c) => c.name);
    if (!names.includes('gender')) db.run('ALTER TABLE faces ADD COLUMN gender TEXT');
    if (!names.includes('vehicle')) db.run('ALTER TABLE faces ADD COLUMN vehicle TEXT');
    if (!names.includes('platform')) db.run('ALTER TABLE faces ADD COLUMN platform TEXT');
    if (!names.includes('description')) db.run('ALTER TABLE faces ADD COLUMN description TEXT');
    if (!names.includes('sold')) db.run('ALTER TABLE faces ADD COLUMN sold INTEGER DEFAULT 0');
    if (!names.includes('antecedentes')) db.run('ALTER TABLE faces ADD COLUMN antecedentes INTEGER DEFAULT 0');
  });

  db.run(`CREATE TABLE IF NOT EXISTS unlocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    face_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    pix_code TEXT,
    asaas_id TEXT,
    status TEXT DEFAULT 'pendente',
    notified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    paid_at TEXT
  )`);
  db.all('PRAGMA table_info(unlocks)', (err, cols) => {
    if (err) return;
    const names = cols.map((c) => c.name);
    if (!names.includes('asaas_id')) db.run('ALTER TABLE unlocks ADD COLUMN asaas_id TEXT');
  });

  db.run(`CREATE TABLE IF NOT EXISTS refills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    asaas_id TEXT,
    status TEXT DEFAULT 'pendente',
    notified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    paid_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS balances (
    chat_id INTEGER PRIMARY KEY,
    credits REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bot_users (
    chat_id INTEGER PRIMARY KEY,
    first_name TEXT,
    username TEXT,
    started_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    credits REAL NOT NULL,
    status TEXT DEFAULT 'ativo',
    used_by INTEGER,
    used_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_chat_id INTEGER NOT NULL,
    referred_chat_id INTEGER NOT NULL UNIQUE,
    reward REAL DEFAULT 10,
    status TEXT DEFAULT 'pendente',
    notified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    paid_at TEXT
  )`);
});

module.exports = db;
