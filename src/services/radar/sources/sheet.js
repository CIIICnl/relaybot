/**
 * Immersive Filmmaking Calendar — public Google Sheet (CSV export).
 *
 * The most import-friendly source: a public sheet of XR/immersive festivals,
 * markets, labs and grants with deadlines. We export the tab as CSV, gate on a
 * content hash (skip entirely when nothing changed since last run), then hand
 * each data row to the LLM extractor as key:value text.
 */

import crypto from 'node:crypto';
import { fetchText, parseCsv } from '../util.js';

const HEADER_HINT = /festival|event|name|title|date|deadline|market|lab|grant|location/i;

export async function scan(source, { watermark, max }) {
  const url =
    `https://docs.google.com/spreadsheets/d/${source.sheetId}/export?format=csv` +
    (source.gid ? `&gid=${source.gid}` : '');

  let csv;
  try {
    csv = await fetchText(url, { timeoutMs: 20000 });
  } catch (error) {
    console.error('⚠️ sheet fetch failed:', error.message);
    return { watermark, items: [] };
  }

  const hash = crypto.createHash('sha1').update(csv).digest('hex');
  if (watermark && watermark === hash) return { watermark, items: [] }; // unchanged

  const rows = parseCsv(csv).filter((r) => r.some((c) => c && c.trim()));
  const headerIdx = rows.findIndex(
    (r) => r.filter((c) => c && c.trim()).length >= 3 && r.some((c) => HEADER_HINT.test(c))
  );
  if (headerIdx === -1) return { watermark: hash, items: [] };

  const header = rows[headerIdx].map((c) => (c || '').trim());
  const items = [];
  for (let i = headerIdx + 1; i < rows.length && items.length < max; i++) {
    const row = rows[i];
    const pairs = header
      .map((h, j) => (h && row[j] && row[j].trim() ? `${h}: ${row[j].trim()}` : null))
      .filter(Boolean);
    if (pairs.length < 2) continue;

    const title = (row[0] || pairs[0] || '').trim();
    items.push({
      url: null,
      sourceUrl: `https://docs.google.com/spreadsheets/d/${source.sheetId}`,
      title,
      rawText: pairs.join('\n'),
      hint: 'Source: Immersive Filmmaking Calendar (Google Sheet row). Fields follow as key: value.',
    });
  }

  return { watermark: hash, items };
}
