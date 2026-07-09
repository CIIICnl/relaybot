/**
 * Radar LLM extraction + relevance scoring.
 *
 * Sources hand raw-ish text (an XRMust event page, an Immersive Wire issue
 * chunk, a sheet row) to `extractEvent()`, which returns a normalized event
 * candidate plus a 0-100 relevance score for the CIIIC / immersive (IX) remit.
 * The relevance model weights NL-relevance and public-values angle higher, per
 * the design doc.
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RADAR_SYSTEM = `You curate event signals for CIIIC (Creative Industries Immersive Impact Coalition),
a Dutch national program for immersive experiences (IX): AR/VR/XR, virtual worlds, spatial
computing, immersive art/film, serious gaming, creative technology and AI, and public values in tech.

You receive raw text about a single event (a web page, newsletter excerpt or calendar row).
Extract structured fields and return ONLY valid JSON (no markdown), with these keys:

- title: string (required) — clean event name, no site boilerplate.
- event_date: string or null — START date as ISO YYYY-MM-DD. Infer the year if only a
  month/day is given (assume the next future occurrence). null if genuinely unknown.
- event_end: string or null — END date ISO YYYY-MM-DD, or null.
- summary: string or null — 1-2 sentence Dutch summary of what it is and why it matters for IX.
- venue: string or null — city and/or venue, or null.
- canonical_url: string or null — the event's OWN website if present in the text
  (not the aggregator page), else null.
- thema: string or null — short topic tag (e.g. "XR-festival", "funding call", "conferentie").
- schaal: string or null — rough scale if inferable ("lokaal","landelijk","internationaal"), else null.
- relevance: integer 0-100 — how relevant for the CIIIC/IX audience. Guidance:
    80-100 immersive/XR/VR/AR or immersive-art/film events, especially NL or EU;
    50-79  adjacent creative-tech / AI / digital-culture / serious-gaming events;
    20-49  tangential (general tech, general culture) with a weak IX angle;
    0-19   clearly off-topic. Weight NL-relevance and a public-values angle upward.
- is_event: boolean — false if the text is not actually about a datable event
  (e.g. a general article, a person, a company profile). If false, other fields may be null.

Be conservative: if uncertain about a field, use null rather than inventing it.`;

/**
 * Extract a single event candidate from raw text.
 * @param {string} rawText  source text (already HTML-stripped where relevant)
 * @param {object} [opts]
 * @param {string} [opts.hint]  extra context (source label, known URL) to steer extraction
 * @returns {Promise<object|null>} parsed fields, or null on hard failure
 */
export async function extractEvent(rawText, opts = {}) {
  const text = String(rawText || '').slice(0, 12000);
  if (!text.trim()) return null;

  const user = opts.hint ? `${opts.hint}\n\n---\n${text}` : text;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: RADAR_SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    return normalizeExtract(parsed);
  } catch (error) {
    console.error('⚠️ Radar extract failed:', error.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Research + funding extraction (phase 2). Same OpenAI client; type-specific
// prompts. Unlike events, the DATE is deterministic and supplied by the source
// (research = feed publication date, funding = SEDIA deadline), so the model is
// only asked for a clean title, a Dutch summary, relevance and a type guard.
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM = `You curate RESEARCH signals for CIIIC (Creative Industries Immersive Impact
Coalition), a Dutch national program for immersive experiences (IX): AR/VR/XR, virtual worlds,
spatial computing, immersive art/film, serious gaming, creative technology and AI, and public
values in tech.

You receive the title + abstract of a recently published paper or article. Return ONLY valid JSON
(no markdown), with these keys:

- title: string (required) — clean paper/article title, no site boilerplate.
- summary: string or null — 1-2 sentence Dutch summary of what it studies and why it matters for IX.
- canonical_url: string or null — the paper's own DOI/landing URL if present in the text, else null.
- venue: string or null — journal / venue name if inferable, else null.
- thema: string or null — short topic tag (e.g. "XR-onderzoek", "HCI-studie", "immersive art").
- relevance: integer 0-100 — how relevant for the CIIIC/IX audience. Guidance:
    80-100 immersive/XR/VR/AR or immersive-art/film research, especially with a human/cultural angle;
    50-79  adjacent creative-tech / HCI / AI / digital-culture research;
    20-49  tangential (general tech/CS) with a weak IX angle;
    0-19   clearly off-topic. Weight a public-values / NL-EU angle upward.
- is_research: boolean — false if the text is not actually about a research paper/article
  (e.g. a call, a person, a company profile). If false, other fields may be null.

Be conservative: if uncertain about a field, use null rather than inventing it. Do NOT output a date.`;

const FUNDING_SYSTEM = `You curate FUNDING signals (open calls, grants, prizes) for CIIIC (Creative
Industries Immersive Impact Coalition), a Dutch national program for immersive experiences (IX):
AR/VR/XR, virtual worlds, immersive art/film, creative technology and digital culture. These are
EXTERNAL funding opportunities — explicitly NOT CIIIC's own schemes.

You receive a funding call's title + description, and often a known deadline and open/closed status
(trust those; do not contradict them). Return ONLY valid JSON (no markdown), with these keys:

- title: string (required) — clean call name.
- summary: string or null — 1-2 sentence Dutch summary: what it funds and for whom, and explicitly
  STATE the deadline and whether the call is open or closed.
- thema: string or null — short tag (e.g. "EU-call", "nationaal fonds", "prijs").
- relevance: integer 0-100 — how relevant for CIIIC's audience. Guidance:
    80-100 immersive/XR or immersive-art/film funding, especially EU/NL;
    50-79  adjacent creative-tech / digital-culture / creative-industries funding;
    20-49  tangential (general tech/research) with a weak IX angle;
    0-19   clearly off-topic. Weight XR + NL/EU up.
- is_funding: boolean — false if the text is not actually a funding opportunity. If false, other
  fields may be null.

Be conservative: if uncertain about a field, use null rather than inventing it.`;

const NEWS_SYSTEM = `You curate NEWS signals for CIIIC (Creative Industries Immersive Impact Coalition),
a Dutch national program for immersive experiences (IX): AR/VR/XR, virtual worlds, spatial computing,
immersive art/film, serious gaming, creative technology and AI, and public values in tech. The audience
is creative-industry professionals, cultural institutions and policymakers in the Netherlands — NOT
consumer gamers.

You receive the title + body of a recently published news article or industry post. Return ONLY valid
JSON (no markdown), with these keys:

- title: string (required) — clean article title, no site boilerplate.
- summary: string or null — 1-2 sentence Dutch summary of the news and why it matters for the IX field.
- thema: string or null — short topic tag (e.g. "immersive art", "XR-industrie", "beleid", "platform").
- relevance: integer 0-100 — how relevant for the CIIIC/IX audience. Guidance:
    80-100 immersive art/culture/creative-industry news, IX funding-landscape or policy news, especially NL or EU;
    50-79  XR industry/platform news with clear creative or public-values relevance (tools, standards, privacy, major studios);
    20-49  consumer-oriented XR news (game releases, hardware reviews, gadget crowdfunding) with a weak creative-industry angle;
    0-19   clearly off-topic. Weight an NL/EU or public-values angle upward; weight pure consumer-gaming down.
- is_news: boolean — false if the text is not actually a news article (e.g. an event listing, a plain
  product page, a funding call — those belong to other radar types). If false, other fields may be null.

Be conservative: if uncertain about a field, use null rather than inventing it. Do NOT output a date.`;

async function complete(system, user) {
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });
  return JSON.parse(completion.choices[0].message.content);
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function clampRelevance(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

/** Extract a research candidate (title + Dutch summary + relevance) from raw text. */
export async function extractResearch(rawText, opts = {}) {
  const text = String(rawText || '').slice(0, 12000);
  if (!text.trim()) return null;
  const user = opts.hint ? `${opts.hint}\n\n---\n${text}` : text;
  try {
    const p = await complete(RESEARCH_SYSTEM, user);
    if (!p || typeof p !== 'object') return null;
    return {
      title: str(p.title),
      summary: str(p.summary),
      canonicalUrl: str(p.canonical_url),
      venue: str(p.venue),
      thema: str(p.thema),
      relevance: clampRelevance(p.relevance),
      isResearch: p.is_research !== false,
    };
  } catch (error) {
    console.error('⚠️ Radar research extract failed:', error.message);
    return null;
  }
}

/** Extract a funding candidate (title + Dutch summary + relevance) from raw text. */
export async function extractFunding(rawText, opts = {}) {
  const text = String(rawText || '').slice(0, 12000);
  if (!text.trim()) return null;
  const user = opts.hint ? `${opts.hint}\n\n---\n${text}` : text;
  try {
    const p = await complete(FUNDING_SYSTEM, user);
    if (!p || typeof p !== 'object') return null;
    return {
      title: str(p.title),
      summary: str(p.summary),
      thema: str(p.thema),
      relevance: clampRelevance(p.relevance),
      isFunding: p.is_funding !== false,
    };
  } catch (error) {
    console.error('⚠️ Radar funding extract failed:', error.message);
    return null;
  }
}

/** Extract a news candidate (title + Dutch summary + relevance) from raw text. */
export async function extractNews(rawText, opts = {}) {
  const text = String(rawText || '').slice(0, 12000);
  if (!text.trim()) return null;
  const user = opts.hint ? `${opts.hint}\n\n---\n${text}` : text;
  try {
    const p = await complete(NEWS_SYSTEM, user);
    if (!p || typeof p !== 'object') return null;
    return {
      title: str(p.title),
      summary: str(p.summary),
      thema: str(p.thema),
      relevance: clampRelevance(p.relevance),
      isNews: p.is_news !== false,
    };
  } catch (error) {
    console.error('⚠️ Radar news extract failed:', error.message);
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(v) {
  return typeof v === 'string' && ISO_DATE.test(v) ? v : null;
}

function normalizeExtract(p) {
  if (!p || typeof p !== 'object') return null;
  const rel = Number(p.relevance);
  return {
    title: typeof p.title === 'string' ? p.title.trim() : null,
    eventDate: cleanDate(p.event_date),
    eventEnd: cleanDate(p.event_end),
    summary: typeof p.summary === 'string' ? p.summary.trim() || null : null,
    venue: typeof p.venue === 'string' ? p.venue.trim() || null : null,
    canonicalUrl: typeof p.canonical_url === 'string' ? p.canonical_url.trim() || null : null,
    thema: typeof p.thema === 'string' ? p.thema.trim() || null : null,
    schaal: typeof p.schaal === 'string' ? p.schaal.trim() || null : null,
    relevance: Number.isFinite(rel) ? Math.max(0, Math.min(100, Math.round(rel))) : null,
    isEvent: p.is_event !== false,
  };
}
