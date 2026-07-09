/**
 * Generic news RSS source (XR/IX industry press + podcasts).
 *
 * Same shape as research-rss.js but for type=news feeds (XRMust magazine,
 * AR Insider, Voices of VR, Road to VR): watermark = newest guid/link,
 * event_date = publication date. Two news-specific twists:
 *   - max-age cutoff (RADAR_NEWS_MAX_AGE_DAYS, default 45): an article older
 *     than that is not "news" — this keeps a first run against a feed with a
 *     long history (Voices of VR ships 200 items) from flooding the inbox.
 *   - optional `source.keywordFilter` for broad feeds, like research-rss.
 */

import { fetchText, parseRss, stripHtml, toIsoDate } from '../util.js';

const MAX_AGE_DAYS = Number(process.env.RADAR_NEWS_MAX_AGE_DAYS ?? 45);

const IMMERSIVE_RE =
  /\b(immersiv|virtual realit|augmented realit|mixed realit|extended realit|\bVR\b|\bAR\b|\bXR\b|\bMR\b|metavers|virtual world|spatial comput|360[- ]?video|volumetric|haptic|head[- ]mounted|holograph)/i;

function tooOld(isoDate) {
  if (!isoDate) return false; // undated items pass; the LLM guard catches junk
  const age = (Date.now() - new Date(`${isoDate}T00:00:00Z`).getTime()) / 86400000;
  return age > MAX_AGE_DAYS;
}

export async function scan(source, { watermark, max }) {
  let xml;
  try {
    xml = await fetchText(source.rssUrl, { timeoutMs: 20000 });
  } catch (error) {
    console.error(`⚠️ news-rss ${source.key} fetch failed:`, error.message);
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

    const pubDate = toIsoDate(entry.pubDate);
    if (tooOld(pubDate)) continue;
    if (source.keywordFilter && !IMMERSIVE_RE.test(`${title} ${body}`)) continue;

    items.push({
      url: entry.link || id,
      sourceUrl: entry.link || source.rssUrl,
      title,
      pubDate,
      rawText: `${title}\n\n${body}`.slice(0, 9000),
      hint: `Source: ${source.label} (news feed).`,
    });
  }

  return { watermark: newWatermark, items };
}
