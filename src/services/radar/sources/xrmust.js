/**
 * XRMust — XR Agenda (WordPress REST, custom post type `all-events`).
 *
 * Discovery is cheap and machine-readable via the WP API; we page through
 * events newest-modified-first and stop at the last run's watermark, so a daily
 * run only picks up new/changed events out of the ~4600 backlog. The event DATE
 * is NOT in the API (meta only holds view counts), so per new event we fetch the
 * public HTML page and hand its text to the LLM extractor.
 */

import { fetchJson, fetchText, stripHtml } from '../util.js';

const PER_PAGE = 50;

export async function scan(source, { watermark, max }) {
  const base = source.apiBase;
  const items = [];
  let newWatermark = watermark || null;
  let page = 1;

  outer: while (items.length < max && page <= 20) {
    const url =
      `${base}?orderby=modified&order=desc&per_page=${PER_PAGE}&page=${page}` +
      `&_fields=id,link,slug,title,modified`;
    let batch;
    try {
      batch = await fetchJson(url);
    } catch (error) {
      // WP returns a 400 "rest_post_invalid_page_number" past the last page.
      if (page === 1) console.error('⚠️ xrmust discovery failed:', error.message);
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const ev of batch) {
      const modified = ev.modified || null;
      // ISO strings compare lexically; stop once we reach already-seen events.
      if (watermark && modified && modified <= watermark) break outer;
      if (!newWatermark || (modified && modified > newWatermark)) newWatermark = modified;

      const link = ev.link;
      const title = stripHtml(ev.title?.rendered || '');
      if (!link || !title) continue;

      let rawText = title;
      try {
        rawText = `${title}\n\n${stripHtml(await fetchText(link)).slice(0, 8000)}`;
      } catch (error) {
        console.error(`⚠️ xrmust page fetch failed (${link}):`, error.message);
      }

      items.push({
        url: link,
        sourceUrl: link,
        title,
        rawText,
        hint: `Source: XRMust XR Agenda. Aggregator page: ${link}`,
      });
      if (items.length >= max) break outer;
    }
    page += 1;
  }

  return { watermark: newWatermark, items };
}
