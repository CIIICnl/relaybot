# Radar phase 2 — research + funding source recon (2026-07-09)

Companion to `radar-source-recon-2026-07-09.md` (events). Records which of the
research + funding sources from `monitor/docs/reference/radar-sources-research-funding.md`
proved reliably machine-scannable, verified live while wiring the daily scan.

## Research — what ships ON

| Source | Method | Verdict |
|---|---|---|
| arXiv cs.HC | Atom API | ✅ reliable, high volume. Needs a ~30s timeout (API is slow); http:// returns empty, use https://. Newest-submitted-first, watermark on newest id. |
| arXiv cs.GR | Atom API | ✅ same as cs.HC. |
| Frontiers in Virtual Reality | RSS | ✅ `…/journals/virtual-reality/rss`, 20 items, clean titles + pubDate. Topically narrow, no prefilter. |
| Elsevier — Computers & Graphics | RSS | ✅ `rss.sciencedirect.com/publication/science/00978493`. Low volume (often 1 item); items sometimes lack a parseable date. |

**event_date = publication date** (deterministic, from the feed). The LLM only
scores relevance + writes the Dutch summary + guards `is_research`. Narrow feeds
get an LLM pass on every item.

### Springer + Nature — blocked from server-side fetch (OFF)

Both have real RSS (`link.springer.com/search.rss?facet-journal-id=10055` = 20
items; `nature.com/srep.rss` = 9) **when reached from a browser or curl**, but a
plain Node `fetch` gets HTTP 200 with a ~3 KB JS bot-challenge HTML page, not XML —
verified 2026-07-09, and a real browser UA + `Accept` headers do **not** help (it's
a JS/cookie challenge, not UA-gating). curl passing earlier was intermittent. So
they need a headless fetch / feed-proxy before they can ship. Scaffolded OFF behind
`RADAR_ENABLE_SPRINGER=1` / `RADAR_ENABLE_NATURE=1`. Nature also ships with
`keywordFilter: true` (broad feed) for when it's re-enabled; its dates come from
`dc:date`.

## Research — scaffolded OFF (phase 2b)

- **EurekAlert!** — the keyword feed URL from the allowlist (`/rss/technology_engineering.xml`)
  404s. Needs a working feed URL before enabling; flag `RADAR_ENABLE_EUREKALERT=1` + `RADAR_EUREKALERT_RSS=`.
- **Immerse (MIT ODL), Voices of VR, Immersive Wire, AR Insider** — newsletter/digest
  feeds. Same problem as events-phase Immersive Wire: one issue mentions many items,
  single-item extraction is lossy. Needs a multi-item extractor.
- **ACM DL, IEEE VR/ISMAR** — gated / no open feed; page-scrape or Xplore API.

## Funding — what ships ON

**`eu-sedia`** — EU Funding & Tenders via the SEDIA search-API
(`https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA`, POST).

Hard-won query reality (verified 2026-07-09):

- The API honours only **`text`** (relevance ranking) and **`terms: { type: [...] }`**.
  Arbitrary Elasticsearch clauses — `wildcard`, `prefix`, `terms: { status }`,
  `terms: { language }` — are **silently ignored** (the response falls back to the
  full 4.1M-doc index). So per-programme / status / deadline filtering is impossible
  server-side and all happens **client-side**.
- Each topic is indexed once per language and repeats across pages, so the top of a
  single keyword page collapses to ~1 unique topic. Fix: pull several pages
  (`RADAR_SEDIA_PAGES=3`, `pageSize=100`) and dedup by `identifier`.
- Real topics are `…/opportunities/topic-details/<ID>` URLs (mixed in with tenders,
  FAQs, webinars). Post-filter on that path.
- Clean structured metadata per topic: `identifier`, `callIdentifier`, `status`
  (numeric: 31094501 forthcoming / 02 open / 03 closed), `deadlineDate` (ISO),
  `descriptionByte` (HTML). **event_date = deadlineDate; extra.status = open|closed|upcoming** (lowercase, matching the seed).
- Programme allowlist maps `callIdentifier`/`identifier` prefix → seed source key
  (`HORIZON-CL4…HUMAN` → horizon-virtual-worlds, `HORIZON-CL2` → horizon-cl2-culture,
  `CREA-MEDIA` → creative-europe-media, `CREA-CULT` → creative-europe-culture,
  `NEB` → new-european-bauhaus). The prefix narrows to the right programmes; the LLM
  relevance floor drops non-immersive HUMAN-cluster topics (e.g. "GenAI for Africa").
- Long-closed rounds are dropped (`RADAR_FUNDING_MAX_CLOSED_DAYS=430`); open / upcoming
  / undated and recently-closed flagship lines are kept (matches the seed's "watch" intent).

**Stand 2026-07-09:** the immersive EU line is between rounds — the scan surfaces the
HORIZON-CL4 *-HUMAN Virtual Worlds topics, currently all recently-closed (deadlines
2025-09/10). CREA-MEDIA / CREA-CULT / CL2 / NEB did not rank into the immersive
keyword results (few open immersive calls right now). This is the real landscape, not
a scan gap; the scan will pick up the next round when a call opens.

## Funding — scaffolded OFF (phase 2b)

- **National funds** (NL Filmfonds Immerse\Interact, CNC, Medienboard, Stimuleringsfonds) —
  single-page scrapes, one selector each. Not yet wired.
- **`coe.int` (Eurimages), `vaf.be`** — block/JS-render plain fetch; need a headless
  browser or newsletter-LLM.
- **STARTS, EMIL, XR4Europe, Culture Moves Europe** — bespoke call pages / newsletters.

## Scan-health

Each run POSTs per-source `{ source, scanned_at, items_found, ok, note? }` to monitor's
`POST /api/radar/scan-report` (see `scanreport.js` + the return briefing). Keyed by the
scanner (config source key); funding signals carry per-programme source keys on the
signal itself, so a per-programme delivered breakdown is derivable monitor-side.
