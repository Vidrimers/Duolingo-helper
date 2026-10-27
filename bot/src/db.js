import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// схема
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    duolingo_user_id TEXT UNIQUE,
    duolingo_username TEXT,
    tg_user_id INTEGER UNIQUE,
    tg_username TEXT,
    jwt_encrypted TEXT,
    linked_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS link_codes (
    code TEXT PRIMARY KEY,
    duolingo_user_id TEXT NOT NULL,
    jwt_encrypted TEXT,
    expires_at INTEGER NOT NULL,
    attempts INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    duolingo_user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_stats (
    duolingo_user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    xp INTEGER DEFAULT 0,
    streak INTEGER DEFAULT 0,
    total_xp INTEGER DEFAULT 0,
    PRIMARY KEY (duolingo_user_id, date)
  );

  CREATE TABLE IF NOT EXISTS banned_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id INTEGER UNIQUE,
    tg_username TEXT,
    duolingo_user_id TEXT,
    duolingo_username TEXT,
    reason TEXT,
    banned_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS script_installs (
    duolingo_user_id TEXT PRIMARY KEY,
    username TEXT,
    first_seen TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bug_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id INTEGER NOT NULL,
    tg_username TEXT,
    duolingo_user_id TEXT,
    duolingo_username TEXT,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'received',
    admin_reply TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    duolingo_user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    ids TEXT NOT NULL,
    name TEXT,
    ts INTEGER NOT NULL,
    delivered INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS friend_scan (
    duolingo_user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    scanned_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_link_codes_expires ON link_codes(expires_at);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
  CREATE INDEX IF NOT EXISTS idx_bug_reports_tg ON bug_reports(tg_user_id);
  CREATE INDEX IF NOT EXISTS idx_users_tg ON users(tg_user_id);
  CREATE INDEX IF NOT EXISTS idx_users_duo ON users(duolingo_user_id);
  CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(duolingo_user_id);
`);

// миграция: добавляем jwt_encrypted если нет
try {
  db.exec(`ALTER TABLE users ADD COLUMN jwt_encrypted TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE link_codes ADD COLUMN jwt_encrypted TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE link_codes ADD COLUMN duolingo_username TEXT`);
} catch {}
// миграция: настройки скрипта для друзей (порог неактивности, исключения)
try {
  db.exec(`ALTER TABLE users ADD COLUMN inactive_days INTEGER DEFAULT 3`);
} catch {}
try {
  db.exec(`ALTER TABLE users ADD COLUMN exclude_list TEXT`);
} catch {}

export default db;
