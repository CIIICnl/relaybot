/**
 * Draft-resume store for publicvalues.ciiic.nl self-assessment
 *
 * Stores in-progress form submissions server-side, keyed by a random
 * magic-link token. The token is delivered via email and is the only
 * way to retrieve a draft. Drafts are purged 30 days after creation.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let db = null;
let stmtInsert = null;
let stmtGet = null;
let stmtPurge = null;
let stmtCount = null;

function getDbPath() {
  return process.env.DRAFT_DB_PATH || '/data/drafts.sqlite';
}

export function initDraftsDb() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      token       TEXT PRIMARY KEY,
      data        TEXT NOT NULL,
      email       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drafts_expires_at ON drafts(expires_at);
    CREATE INDEX IF NOT EXISTS drafts_email_created ON drafts(email, created_at);
  `);

  stmtInsert = db.prepare(
    'INSERT INTO drafts (token, data, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  );
  stmtGet = db.prepare(
    'SELECT data, email, created_at, expires_at FROM drafts WHERE token = ?'
  );
  stmtPurge = db.prepare('DELETE FROM drafts WHERE expires_at < ?');
  stmtCount = db.prepare('SELECT COUNT(*) AS n FROM drafts');

  return { dbPath };
}

function ensureReady() {
  if (!db) throw new Error('drafts DB not initialised — call initDraftsDb() first');
}

export function saveDraft({ data, email }) {
  ensureReady();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + THIRTY_DAYS_MS;
  stmtInsert.run(token, JSON.stringify(data), email.toLowerCase(), now, expiresAt);
  return { token, expiresAt };
}

export function getDraft(token) {
  ensureReady();
  const row = stmtGet.get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return {
    data: JSON.parse(row.data),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function deleteDraft(token) {
  ensureReady();
  const result = db.prepare('DELETE FROM drafts WHERE token = ?').run(token);
  return result.changes > 0;
}

export function purgeExpired() {
  ensureReady();
  const result = stmtPurge.run(Date.now());
  return result.changes;
}

export function countDrafts() {
  ensureReady();
  return stmtCount.get().n;
}

export function healthCheck() {
  try {
    ensureReady();
    return { success: true, count: countDrafts(), dbPath: getDbPath() };
  } catch (error) {
    return { success: false, error: error.message, dbPath: getDbPath() };
  }
}
