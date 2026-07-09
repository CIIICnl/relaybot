/**
 * Generic research RSS/Atom source (journals + news feeds).
 *
 * Used for topically-narrow feeds (Frontiers in VR, Springer Virtual Reality,
 * Elsevier Computers & Graphics) where every item is worth an LLM pass, and for
 * broad feeds (Nature Scientific Reports) where `source.keywordFilter` gates the
 * LLM to items whose title/abstract actually mention immersive terms — that keeps
 * the relevance-scoring cost down on a firehose of general science.
 *
 * Watermark = newest item guid/link seen. event_date = publication date.
 */

import { fetchText, parseRss, stripHtml, toIsoDate } from '../util.js';

// Cheap prefilter for broad feeds: drop items with no immersive-ish term before
// spending an LLM call. Narrow feeds set keywordFilter=false and skip this.
const IMMERSIVE_RE =
  /\b(immersiv|virtual realit|augmented realit|mixed realit|extended realit|\bVR\b|\bAR\b|\bXR\b|\bMR\b|metavers|virtual world|spatial comput|360[- ]?video|volumetric|haptic|head[- ]mounted|holograph)/i;

export async function scan(source, { watermark, max }) {
  let xml;
  try {
    xml = await fetchText(source.rssUrl, { timeoutMs: 20000 });
  } catch (error) {
    console.error(`⚠️ research-rss ${source.key} fetch failed:`, error.message);
    return { watermark, items: [] };
  }

  const feed = parseRss(xml);
  const items = [];
  let newWatermark = watermark || null;

  for (let i = 0; i < feed.length && items.length < max; i++) {
    const entry = feed[i];
    const id = entry.guid || entry.link;
    if (i === 0 && id) newWatermark = id;
    if (watermark && id && id === watermark) break; // caught up

    const title = stripHtml(entry.title || '').replace(/\s+/g, ' ').trim();
    const body = stripHtml(entry.content || '');
    if (!title && !body) continue;

    if (source.keywordFilter && !IMMERSIVE_RE.test(`${title} ${body}`)) continue;

    items.push({
      url: entry.link || id,
      sourceUrl: entry.link || source.rssUrl,
      title,
      pubDate: toIsoDate(entry.pubDate),
      rawText: `${title}\n\n${body}`.slice(0, 9000),
      hint: `Source: ${source.label} (research feed).`,
    });
  }

  return { watermark: newWatermark, items };
}
