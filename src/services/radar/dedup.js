/**
 * Radar dedup helpers.
 *
 *  - normalizeDedupKey(): stable, normalized key monitor upserts on
 *    (ON CONFLICT (dedup_key)). Prefer a canonical URL reduced to host+path;
 *    fall back to slug(title)|event_date.
 *  - loadExistingEventKeys() / existsInCalendar(): best-effort check against the
 *    Notion Event Calendar so already-listed events don't become inbox noise.
 *    The relay never writes here — read-only.
 */

import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_SECRET });
const EVENTS_DB_ID = process.env.NOTION_EVENTS_DATABASE_ID;

export function slug(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Reduce a URL to a stable `host/path` (no protocol, www, query, fragment, trailing slash). */
export function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Build the dedup_key for a candidate. `canonicalUrl` (the real event website,
 * if extracted) is preferred over the source page URL so the same event found
 * via two sources collides. Falls back to slug(title)|event_date.
 */
export function normalizeDedupKey({ canonicalUrl, url, title, eventDate }) {
  const fromUrl = normalizeUrl(canonicalUrl) || normalizeUrl(url);
  if (fromUrl) return fromUrl;
  const s = slug(title);
  return eventDate ? `${s}|${eventDate}` : s;
}

/**
 * Load a Set of normalized keys for events already in the Notion Event Calendar.
 * Keys: slug(title) and slug(title)|YYYY. Best-effort; on any error returns an
 * empty set so dedup simply doesn't filter (candidates still flow to monitor,
 * which dedups on its side).
 */
export async function loadExistingEventKeys({ maxPages = 20 } = {}) {
  const keys = new Set();
  if (!EVENTS_DB_ID) return keys;
  try {
    let cursor;
    let pages = 0;
    do {
      const res = await notion.databases.query({
        database_id: EVENTS_DB_ID,
        page_size: 100,
        start_cursor: cursor,
      });
      for (const page of res.results) {
        const props = page.properties || {};
        const title = (props['Event name']?.title || [])
          .map((t) => t.plain_text)
          .join('')
          .trim();
        if (!title) continue;
        const s = slug(title);
        keys.add(s);
        const start = props['Event date']?.date?.start;
        if (start) keys.add(`${s}|${start.slice(0, 4)}`);
      }
      cursor = res.has_more ? res.next_cursor : undefined;
      pages += 1;
    } while (cursor && pages < maxPages);
  } catch (error) {
    console.error('⚠️ Radar: could not load Event Calendar keys:', error.message);
  }
  return keys;
}

/** True if a candidate looks like it's already in the calendar (by title, or title+year). */
export function existsInCalendar(candidate, keys) {
  if (!keys || keys.size === 0) return false;
  const s = slug(candidate.title);
  if (keys.has(s)) return true;
  if (candidate.eventDate && keys.has(`${s}|${candidate.eventDate.slice(0, 4)}`)) return true;
  return false;
}
