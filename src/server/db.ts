import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS rate_card (
  market         TEXT PRIMARY KEY,
  iso            TEXT,           -- comma-separated ISO codes billed at this market
  currency       TEXT NOT NULL,
  marketing_rate REAL NOT NULL,
  imported_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  language               TEXT NOT NULL,
  status                 TEXT,
  category               TEXT,
  components_json        TEXT,
  optimization_spec_json TEXT,   -- normalised: overrides as a map, or NULL for rate card
  arm                    TEXT,   -- 'A' (rate card) | 'B' (max price) | NULL
  pair_id                TEXT,
  synced_at              TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  wamid                  TEXT PRIMARY KEY,
  to_masked              TEXT,
  country                TEXT,
  template_id            TEXT,
  template_name          TEXT,
  arm                    TEXT,
  sent_at                TEXT,
  send_response_json     TEXT,
  per_message_multiplier REAL
);

CREATE TABLE IF NOT EXISTS statuses (
  wamid         TEXT NOT NULL,
  status        TEXT NOT NULL,
  ts            INTEGER,
  billable      INTEGER,
  pricing_model TEXT,
  category      TEXT,
  pricing_type  TEXT,
  cost_amount   REAL,
  cost_currency TEXT,
  error_code    INTEGER,
  raw_json      TEXT,
  PRIMARY KEY (wamid, status)
);

CREATE TABLE IF NOT EXISTS webhook_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  body        TEXT NOT NULL
);
`;

export function openDb(path = process.env.DB_PATH ?? 'data/app.db'): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// ---- settings -------------------------------------------------------------

export interface Settings {
  provider: '360dialog' | 'meta';
  apiKey: string | null;
  metaAccessToken: string | null;
  metaWabaId: string;
  metaPhoneNumberId: string;
  metaApiVersion: string;
  wabaCurrency: string;
  webhookUrl: string;
  sendRatePerSecond: number;
  rateCardTitle: string | null;
  rateCardEffective: string | null;
}

const DEFAULTS: Record<string, string> = {
  provider: '360dialog',
  meta_waba_id: '',
  meta_phone_number_id: '',
  meta_api_version: 'v27.0',
  waba_currency: 'EUR',
  webhook_url: '',
  send_rate_per_second: '10',
};

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key] ?? null;
}

export function setSetting(db: DB, key: string, value: string | null) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getSettings(db: DB): Settings {
  return {
    provider: getSetting(db, 'provider') === 'meta' ? 'meta' : '360dialog',
    apiKey: getSetting(db, 'api_key'),
    metaAccessToken: getSetting(db, 'meta_access_token'),
    metaWabaId: getSetting(db, 'meta_waba_id')!,
    metaPhoneNumberId: getSetting(db, 'meta_phone_number_id')!,
    metaApiVersion: getSetting(db, 'meta_api_version')!,
    wabaCurrency: getSetting(db, 'waba_currency')!,
    webhookUrl: getSetting(db, 'webhook_url')!,
    sendRatePerSecond: Number(getSetting(db, 'send_rate_per_second')),
    rateCardTitle: getSetting(db, 'rate_card_title'),
    rateCardEffective: getSetting(db, 'rate_card_effective'),
  };
}

export function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}
