/**
 * arXiv — new-paper feed via the public Atom API (no key, very reliable).
 *
 * We pull one category (cs.HC or cs.GR) newest-submitted-first and stop at the
 * last run's watermark (newest paper id seen), so a daily run only picks up new
 * papers. These categories are topically narrow enough that every entry is worth
 * an LLM relevance pass; the extractor + relevance floor drop the off-topic ones.
 * event_date = the paper's publication date (deterministic, from the feed).
 */

import { fetchText, parseRss, stripHtml, toIsoDate } from '../util.js';

const API = 'https://export.arxiv.org/api/query';

export async function scan(source, { watermark, max }) {
  const cat = source.arxivCat;
  const url =
    `${API}?search_query=cat:${encodeURIComponent(cat)}` +
    `&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${Math.min(max, 50)}`;

  let xml;
  try {
    xml = await fetchText(url, { timeoutMs: 30000 });
  } catch (error) {
    console.error(`⚠️ arxiv ${cat} fetch failed:`, error.message);
    return { watermark, items: [] };
  }

  const feed = parseRss(xml);
  const items = [];
  let newWatermark = watermark || null;

  for (let i = 0; i < feed.length && items.length < max; i++) {
    const entry = feed[i];
    const id = entry.guid || entry.link;
    if (i === 0 && id) newWatermark = id;
    if (watermark && id && id === watermark) break; // caught up to last run

    const link = entry.link || id;
    const title = stripHtml(entry.title || '').replace(/\s+/g, ' ').trim();
    const abstract = stripHtml(entry.content || '');
    if (!title) continue;

    items.push({
      url: link,
      sourceUrl: link,
      title,
      pubDate: toIsoDate(entry.pubDate),
      rawText: `${title}\n\n${abstract}`.slice(0, 9000),
      hint: `Source: arXiv ${cat} (preprint). This is an academic paper abstract.`,
    });
  }

  return { watermark: newWatermark, items };
}
