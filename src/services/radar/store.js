/**
 * Radar local store (better-sqlite3) — watermarks + seen dedup_keys.
 *
 * Two jobs:
 *  1. Per-source incremental watermark (e.g. XRMust highest `modified` seen,
 *     Immersive Wire last processed item guid) so a daily run only touches
 *     new/changed items instead of re-scanning everything.
 *  2. A seen-store of dedup_keys we already extracted + posted, with a content
 *     hash, so we don't re-run the LLM and re-POST unchanged items every day.
 *     (Monitor also dedups via ON CONFLICT, but this saves cost upstream.)
 *
 * Mirrors the drafts.js pattern: file under the /data Docker volume, WAL mode,
 * prepared statements, lazy init.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

let db = null;
let stmtGetWm = null;
let stmtSetWm = null;
let stmtGetSeen = null;
let stmtUpsertSeen = null;
let stmtCountSeen = null;

export function initRadarDb() {
  if (db) return { dbPath: DB_PATH }; // idempotent — one handle per process
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_watermarks (
      source     TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS radar_seen (
      dedup_key    TEXT PRIMARY KEY,
      source       TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      posted_at    INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS radar_seen_source ON radar_seen(source);
  `);

  stmtGetWm = db.prepare('SELECT value FROM radar_watermarks WHERE source = ?');
  stmtSetWm = db.prepare(
    `INSERT INTO radar_watermarks (source, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  stmtGetSeen = db.prepare('SELECT content_hash FROM radar_seen WHERE dedup_key = ?');
  stmtUpsertSeen = db.prepare(
    `INSERT INTO radar_seen (dedup_key, source, content_hash, posted_at, last_seen_at)
     VALUES (@dedup_key, @source, @content_hash, @now, @now)
     ON CONFLICT(dedup_key) DO UPDATE SET content_hash = excluded.content_hash, last_seen_at = excluded.last_seen_at`
  );
  stmtCountSeen = db.prepare('SELECT COUNT(*) AS n FROM radar_seen');

  return { dbPath: DB_PATH };
}

function ensureReady() {
  if (!db) throw new Error('radar DB not initialised — call initRadarDb() first');
}

export function getWatermark(source) {
  ensureReady();
  return stmtGetWm.get(source)?.value ?? null;
}

export function setWatermark(source, value) {
  ensureReady();
  if (value == null) return;
  stmtSetWm.run(source, String(value), Date.now());
}

export function hashContent(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Has this dedup_key already been posted with the same content hash?
 * Used to skip unchanged items (no re-LLM, no re-POST).
 */
export function isUnchanged(dedupKey, contentHash) {
  ensureReady();
  return stmtGetSeen.get(dedupKey)?.content_hash === contentHash;
}

/**
 * Classify a candidate against the seen-store, for the Slack digest:
 *   'new'       — dedup_key never seen before (worth announcing)
 *   'changed'   — seen before, but content changed (an update, not announced)
 *   'unchanged' — seen before with the same content (skipped entirely)
 */
export function seenState(dedupKey, contentHash) {
  ensureReady();
  const row = stmtGetSeen.get(dedupKey);
  if (!row) return 'new';
  return row.content_hash === contentHash ? 'unchanged' : 'changed';
}

/**
 * One-time priming flag (stored as a pseudo-watermark) so the first scan after
 * enabling the digest doesn't dump the whole research/funding/news backfill into
 * Slack. First run primes silently; subsequent runs post normally.
 */
const SLACK_PRIMED_KEY = '__radar_slack_primed__';
export function isSlackPrimed() {
  ensureReady();
  return getWatermark(SLACK_PRIMED_KEY) === '1';
}
export function setSlackPrimed() {
  ensureReady();
  setWatermark(SLACK_PRIMED_KEY, '1');
}

export function markPosted(dedupKey, source, contentHash) {
  ensureReady();
  stmtUpsertSeen.run({
    dedup_key: dedupKey,
    source,
    content_hash: contentHash,
    now: Date.now(),
  });
}

export function countSeen() {
  ensureReady();
  return stmtCountSeen.get().n;
}

export function radarHealth() {
  try {
    ensureReady();
    return { success: true, seen: countSeen(), dbPath: DB_PATH };
  } catch (error) {
    return { success: false, error: error.message, dbPath: DB_PATH };
  }
}
