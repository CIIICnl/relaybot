/**
 * EU Funding & Tenders — via the SEDIA search-API (NOT the JS portal).
 *
 * The public portal is a JS SPA and cannot be scraped; its backing search-API is
 * a POST endpoint that returns structured topic metadata (callIdentifier,
 * deadlineDate, status, description) as JSON. We keyword-search for immersive
 * topics, keep only real call topics (`/topic-details/` URLs), and filter their
 * identifier against an allowlist of programme prefixes that carry CIIIC-relevant
 * calls. Each surviving topic is mapped to the matching seed source key so the
 * daily scan lines up with the seeded funding rows in the /radar/bronnen view.
 *
 * event_date = the call DEADLINE. extra.status = open|closed|upcoming (lowercase,
 * matching the seed). No incremental watermark: the result set is small and the
 * seen-store skips unchanged topics, so a full re-query each day is cheap.
 */

import { stripHtml, toIsoDate } from '../util.js';
import { USER_AGENT } from '../config.js';

const SEARCH_URL =
  'https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA';

// Keyword text steers relevance ranking; the allowlist below does the real
// gating. Broad on purpose so we don't miss an oddly-titled immersive call. NOTE:
// the SEDIA API honours only `text` + `terms:type` — wildcard/prefix/status query
// clauses are silently ignored (verified 2026-07-09), so all real filtering
// (programme, status, deadline age) happens client-side below.
const TEXT =
  'immersive virtual reality augmented XR virtual worlds spatial computing creative europe culture media bauhaus';

// Topic pages are mixed in with tenders/news/FAQs and each topic is indexed once
// per language, so a wide page over several pages is needed to surface enough
// unique `/topic-details/` items before filtering (1 page ≈ 1 unique topic here).
const PAGE_SIZE = Number(process.env.RADAR_SEDIA_PAGE_SIZE ?? 100);
const PAGES = Number(process.env.RADAR_SEDIA_PAGES ?? 3);

// Drop long-closed calls to keep ancient rounds out of the inbox; keep open /
// upcoming / undated always, and recently-closed ones (flagship lines worth
// watching for the next round, matching the seed's intent). Default ~14 months.
const MAX_CLOSED_DAYS = Number(process.env.RADAR_FUNDING_MAX_CLOSED_DAYS ?? 430);

function daysPast(isoDate) {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(`${isoDate}T00:00:00Z`).getTime();
  return Math.floor(ms / 86400000);
}

// callIdentifier / topic-identifier prefix → seed funding source key. Only topics
// whose identifier matches one of these survive (everything else is off-remit).
const PROGRAMME_MAP = [
  { re: /HORIZON-CL4.*HUMAN/i, key: 'horizon-virtual-worlds' },
  { re: /HORIZON-CL2/i, key: 'horizon-cl2-culture' },
  { re: /CREA-MEDIA/i, key: 'creative-europe-media' },
  { re: /CREA-CULT/i, key: 'creative-europe-culture' },
  { re: /NEB|NEW-EUROPEAN-BAUHAUS/i, key: 'new-european-bauhaus' },
];

// SEDIA numeric status codes → our lowercase status vocabulary.
const STATUS_CODE = {
  31094501: 'upcoming', // Forthcoming
  31094502: 'open',
  31094503: 'closed',
};

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

function resolveSource(identifier, callIdentifier) {
  const hay = `${identifier || ''} ${callIdentifier || ''}`;
  for (const p of PROGRAMME_MAP) if (p.re.test(hay)) return p.key;
  return null;
}

function resolveStatus(code, deadline) {
  const mapped = STATUS_CODE[Number(code)];
  if (mapped) return mapped;
  if (deadline) return deadline >= new Date().toISOString().slice(0, 10) ? 'open' : 'closed';
  return null;
}

async function fetchPage(pageNumber) {
  const res = await fetch(
    `${SEARCH_URL}&text=${encodeURIComponent(TEXT)}&pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        query: JSON.stringify({ bool: { must: [{ terms: { type: ['1', '2'] } }] } }),
      }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.results) ? json.results : [];
}

export async function scan(source, { max }) {
  const items = [];
  const seen = new Set(); // one entry per language + repeats across pages → emit each topic once

  for (let page = 1; page <= PAGES && items.length < max; page++) {
    let results;
    try {
      results = await fetchPage(page);
    } catch (error) {
      console.error(`⚠️ sedia search page ${page} failed:`, error.message);
      if (page === 1) return { watermark: null, items: [] };
      break; // keep what earlier pages gave us
    }
    if (results.length === 0) break;

    for (const r of results) {
      if (items.length >= max) break;
      const url = r.url || '';
      if (!url.includes('/topic-details/')) continue;

      const m = r.metadata || {};
      const identifier = first(m.identifier);
      const callIdentifier = first(m.callIdentifier);
      const sourceKey = resolveSource(identifier, callIdentifier);
      if (!sourceKey) continue; // not an allowlisted programme

      const dedupe = identifier || url;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      const deadline = toIsoDate(first(m.deadlineDate));
      const status = resolveStatus(first(m.status), deadline);
      // Skip ancient closed rounds; keep open/upcoming/undated + recently-closed.
      if (status === 'closed') {
        const past = daysPast(deadline);
        if (past != null && past > MAX_CLOSED_DAYS) continue;
      }

      const title = stripHtml(first(m.title) || r.title || identifier || '').trim();
      const description = stripHtml(first(m.descriptionByte) || r.summary || '');

      items.push({
        url,
        sourceUrl: url,
        sourceKey,
        title,
        deadline,
        status,
        callIdentifier: callIdentifier || identifier || null,
        rawText: `${title}\n\n${description}`.slice(0, 9000),
        hint:
          `Source: EU Funding & Tenders topic ${identifier || ''}.` +
          (deadline ? ` Known deadline: ${deadline}.` : '') +
          (status ? ` Status: ${status}.` : ''),
      });
    }
  }

  return { watermark: null, items };
}
