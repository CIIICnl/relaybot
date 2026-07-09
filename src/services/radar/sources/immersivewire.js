/**
 * Immersive Wire (Tom Ffiske) — beehiiv newsletter, RSS at /rss-feed.
 *
 * Issues are XR-tech news digests, not single-event pages, so extraction is
 * best-effort: each new issue is handed to the LLM, which returns is_event=false
 * for pure news roundups (dropped) and a structured event only when an issue is
 * genuinely a single-event announcement. Watermark = newest item guid seen.
 *
 * NOTE (phase 1b): full value needs a multi-event extractor that pulls every
 * event mentioned in a digest; v1 deliberately captures at most one per issue to
 * keep noise low. See docs/radar-source-recon-2026-07-09.md.
 */

import { fetchText, parseRss, stripHtml } from '../util.js';

export async function scan(source, { watermark, max }) {
  let xml;
  try {
    xml = await fetchText(source.rssUrl);
  } catch (error) {
    console.error('⚠️ immersive-wire RSS fetch failed:', error.message);
    return { watermark, items: [] };
  }

  const feed = parseRss(xml);
  const items = [];
  let newWatermark = watermark || null;

  for (let i = 0; i < feed.length && items.length < max; i++) {
    const entry = feed[i];
    if (i === 0 && entry.guid) newWatermark = entry.guid;
    if (watermark && entry.guid && entry.guid === watermark) break; // caught up

    const body = stripHtml(entry.content || '');
    if (!entry.title && !body) continue;

    items.push({
      url: entry.link,
      sourceUrl: entry.link || source.rssUrl,
      title: entry.title,
      rawText: `${entry.title}\n\n${body}`.slice(0, 9000),
      hint:
        'Source: Immersive Wire newsletter issue (news digest). Extract the single most ' +
        'prominent datable event if the issue announces one; otherwise set is_event=false.',
    });
  }

  return { watermark: newWatermark, items };
}
