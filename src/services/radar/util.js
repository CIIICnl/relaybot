/**
 * Small dependency-free helpers for radar sources: HTTP fetch with a timeout
 * and UA, HTML→text, minimal RSS and CSV parsing. Node 20 global fetch.
 */

import { USER_AGENT } from './config.js';

export async function fetchText(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { headers: { Accept: 'application/json' }, ...opts });
  return JSON.parse(text);
}

/** Strip tags + scripts/styles and collapse whitespace to a plain-text blob. */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse an RSS/Atom feed into [{ title, link, guid, pubDate, content }]. */
export function parseRss(xml) {
  const items = [];
  const blocks = String(xml || '').match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .trim();
    };
    // Atom <link href="..."/> vs RSS <link>...</link>
    let link = pick('link');
    if (!link) {
      const m = b.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    items.push({
      title: stripHtml(pick('title') || ''),
      link: link || null,
      guid: pick('guid') || pick('id') || link || null,
      pubDate: pick('pubDate') || pick('updated') || pick('published') || null,
      content: pick('content:encoded') || pick('content') || pick('description') || pick('summary') || '',
    });
  }
  return items;
}

/** Parse CSV text into an array of string arrays (handles quotes + embedded commas/newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignore; handled by \n
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
