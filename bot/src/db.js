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
    linked_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS link_codes (
    code TEXT PRIMARY KEY,
    duolingo_user_id TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS idx_link_codes_expires ON link_codes(expires_at);
  CREATE INDEX IF NOT EXISTS idx_users_tg ON users(tg_user_id);
  CREATE INDEX IF NOT EXISTS idx_users_duo ON users(duolingo_user_id);
  CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(duolingo_user_id);
`);

export default db;
