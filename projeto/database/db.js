const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = process.env.DB_PATH || path.join(__dirname, 'painel.db');
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
    created_at TEXT DEFAULT (datetime('now','localtime')),
    sold_uber INTEGER DEFAULT 0,
    sold_99 INTEGER DEFAULT 0
  )`);

  const addColumn = (table, ddl, afterCreate) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`, (err) => {
      if (!err) {
        if (afterCreate) afterCreate();
      } else if (!/duplicate column/i.test(err.message)) {
        console.error(`[db] Erro ao migrar ${table}:`, err.message);
      }
    });
  };

  addColumn('faces', 'gender TEXT');
  addColumn('faces', 'vehicle TEXT');
  addColumn('faces', 'platform TEXT');
  addColumn('faces', 'description TEXT');
  addColumn('faces', 'sold INTEGER DEFAULT 0');
  addColumn('faces', 'antecedentes INTEGER DEFAULT 0');
  addColumn('faces', 'sold_uber INTEGER DEFAULT 0', () => {
    db.run('UPDATE faces SET sold_uber = COALESCE(sold, 0)');
  });
  addColumn('faces', 'sold_99 INTEGER DEFAULT 0', () => {
    db.run('UPDATE faces SET sold_99 = COALESCE(sold, 0)');
  });
  addColumn('faces', 'category TEXT');
  addColumn('faces', 'photo_hash TEXT');
  addColumn('faces', 'price REAL');
  addColumn('faces', 'cpf TEXT');

  db.run(`CREATE TABLE IF NOT EXISTS unlocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    face_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    pix_code TEXT,
    asaas_id TEXT,
    platform TEXT,
    status TEXT DEFAULT 'pendente',
    notified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    paid_at TEXT
  )`);
  addColumn('unlocks', 'asaas_id TEXT');
  addColumn('unlocks', 'platform TEXT');

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
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
});

module.exports = db;
