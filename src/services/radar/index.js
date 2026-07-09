/**
 * Radar orchestrator — daily scan → extract → dedup → ingest, for all types.
 *
 * For each enabled source: pull new/changed items (incremental via watermark),
 * run the type-appropriate LLM extractor + score, drop below the relevance floor
 * / already-known / unchanged-since-last-post, then batch-POST the survivors to
 * monitor's ingest endpoint. After each source it reports scan-health so the
 * /radar/bronnen overview can show "scanned today / delivered N / ok?". The relay
 * never writes to Notion here.
 *
 * Date + dedup semantics per type:
 *   event    — event_date = start date;   dedup_key = normalizeUrl (phase 1);   Event-Calendar check.
 *   research — event_date = publication;  dedup_key = seed convention;          no calendar check.
 *   funding  — event_date = deadline;     dedup_key = seed convention;          extra.status open/closed/upcoming.
 *   news     — event_date = publication;  dedup_key = seed convention;          no calendar check, no promote target.
 */

import {
  enabledSources,
  isConfigured,
  RELEVANCE_FLOOR,
  MAX_ITEMS_PER_SOURCE,
  SCAN_HOUR,
} from './config.js';
import {
  initRadarDb,
  getWatermark,
  setWatermark,
  isUnchanged,
  markPosted,
  hashContent,
  radarHealth,
} from './store.js';
import { extractEvent, extractResearch, extractFunding, extractNews } from './extract.js';
import {
  normalizeDedupKey,
  seedDedupKey,
  loadExistingEventKeys,
  existsInCalendar,
} from './dedup.js';
import { postSignals } from './ingest.js';
import { postScanReports } from './scanreport.js';
import { scan as xrmustScan } from './sources/xrmust.js';
import { scan as sheetScan } from './sources/sheet.js';
import { scan as wireScan } from './sources/immersivewire.js';
import { scan as arxivScan } from './sources/arxiv.js';
import { scan as researchRssScan } from './sources/research-rss.js';
import { scan as newsRssScan } from './sources/news-rss.js';
import { scan as sediaScan } from './sources/sedia.js';

// Keyed by source.method so a new research/funding feed needs only a config entry.
const SCANNERS = {
  api: xrmustScan,
  csv: sheetScan,
  rss: wireScan,
  arxiv: arxivScan,
  'research-rss': researchRssScan,
  'news-rss': newsRssScan,
  sedia: sediaScan,
};

function pruneNulls(obj) {
  for (const k of Object.keys(obj)) if (obj[k] == null) delete obj[k];
  return obj;
}

function buildEventSignal(source, item, ex) {
  const extra = pruneNulls({
    event_end: ex.eventEnd,
    venue: ex.venue,
    thema: ex.thema,
    schaal: ex.schaal,
  });
  return {
    source: source.key,
    source_url: item.sourceUrl || null,
    type: 'event',
    title: ex.title,
    summary: ex.summary,
    url: ex.canonicalUrl || item.url || null,
    event_date: ex.eventDate,
    extra: Object.keys(extra).length ? extra : null,
    relevance: ex.relevance,
    dedup_key: normalizeDedupKey({
      canonicalUrl: ex.canonicalUrl,
      url: item.url,
      title: ex.title,
      eventDate: ex.eventDate,
    }),
  };
}

function buildResearchSignal(source, item, ex) {
  const sourceKey = item.sourceKey || source.key;
  const url = ex.canonicalUrl || item.url || null;
  const extra = pruneNulls({ venue: ex.venue, thema: ex.thema });
  return {
    source: sourceKey,
    source_url: item.sourceUrl || null,
    type: 'research',
    title: ex.title,
    summary: ex.summary,
    url,
    event_date: item.pubDate || null, // publication date (deterministic, from feed)
    extra: Object.keys(extra).length ? extra : null,
    relevance: ex.relevance,
    dedup_key: seedDedupKey({ url, source: sourceKey, title: ex.title }),
  };
}

function buildFundingSignal(source, item, ex) {
  const sourceKey = item.sourceKey || source.key;
  const url = item.url || null;
  const title = ex.title || item.title;
  const extra = pruneNulls({
    status: item.status || null, // open | closed | upcoming (from the source)
    call_identifier: item.callIdentifier || null,
    thema: ex.thema,
  });
  return {
    source: sourceKey,
    source_url: item.sourceUrl || null,
    type: 'funding',
    title,
    summary: ex.summary,
    url,
    event_date: item.deadline || null, // the call DEADLINE
    extra: Object.keys(extra).length ? extra : null,
    relevance: ex.relevance,
    dedup_key: seedDedupKey({ url, source: sourceKey, title }),
  };
}

function buildNewsSignal(source, item, ex) {
  const sourceKey = item.sourceKey || source.key;
  const url = item.url || null;
  const extra = pruneNulls({ thema: ex.thema });
  return {
    source: sourceKey,
    source_url: item.sourceUrl || null,
    type: 'news',
    title: ex.title,
    summary: ex.summary,
    url,
    event_date: item.pubDate || null, // publication date (deterministic, from feed)
    extra: Object.keys(extra).length ? extra : null,
    relevance: ex.relevance,
    dedup_key: seedDedupKey({ url, source: sourceKey, title: ex.title }),
  };
}

/** Extract + build one signal for an item, per its source type. Returns a signal or null. */
async function processItem(source, item, calendarKeys) {
  if (source.type === 'news') {
    const ex = await extractNews(item.rawText, { hint: item.hint });
    if (!ex || !ex.isNews || !ex.title) return null;
    if (ex.relevance != null && ex.relevance < RELEVANCE_FLOOR) return null;
    return buildNewsSignal(source, item, ex);
  }
  if (source.type === 'research') {
    const ex = await extractResearch(item.rawText, { hint: item.hint });
    if (!ex || !ex.isResearch || !ex.title) return null;
    if (ex.relevance != null && ex.relevance < RELEVANCE_FLOOR) return null;
    return buildResearchSignal(source, item, ex);
  }
  if (source.type === 'funding') {
    const ex = await extractFunding(item.rawText, { hint: item.hint });
    if (!ex || !ex.isFunding || !(ex.title || item.title)) return null;
    if (ex.relevance != null && ex.relevance < RELEVANCE_FLOOR) return null;
    return buildFundingSignal(source, item, ex);
  }
  // event
  const ex = await extractEvent(item.rawText, { hint: item.hint });
  if (!ex || !ex.isEvent || !ex.title) return null;
  if (ex.relevance != null && ex.relevance < RELEVANCE_FLOOR) return null;
  if (existsInCalendar({ title: ex.title, eventDate: ex.eventDate }, calendarKeys)) return null;
  return buildEventSignal(source, item, ex);
}

/**
 * Run one full radar scan.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] extract + dedup but do not POST or advance watermarks
 * @param {string}  [opts.only]   restrict to a single source key (testing)
 * @param {string}  [opts.type]   restrict to a single type: event | research | funding | news
 */
export async function runRadarScan({ dryRun = false, only = null, type = null } = {}) {
  const startedAt = Date.now();
  const scannedAtIso = new Date(startedAt).toISOString();
  if (!isConfigured() && !dryRun) {
    return { ok: false, error: 'RADAR_INGEST_SECRET not configured' };
  }

  const sources = enabledSources().filter(
    (s) => (!only || s.key === only) && (!type || s.type === type)
  );
  // The Event-Calendar dedup read only matters if an event source is in scope.
  const calendarKeys = sources.some((s) => s.type === 'event')
    ? await loadExistingEventKeys()
    : new Set();

  const perSource = {};
  const signals = [];

  for (const source of sources) {
    const stats = { type: source.type, scanned: 0, queued: 0, skipped: 0, error: null };
    try {
      const scanner = SCANNERS[source.method];
      if (!scanner) throw new Error(`no scanner for method '${source.method}'`);

      const wm = getWatermark(source.key);
      const { watermark, items } = await scanner(source, { watermark: wm, max: MAX_ITEMS_PER_SOURCE });
      stats.scanned = items.length;

      for (const item of items) {
        const signal = await processItem(source, item, calendarKeys);
        if (!signal) { stats.skipped++; continue; }

        const contentHash = hashContent(signal);
        if (isUnchanged(signal.dedup_key, contentHash)) { stats.skipped++; continue; }

        signal.__hash = contentHash;
        signals.push(signal);
        stats.queued++;
      }

      if (!dryRun) setWatermark(source.key, watermark);
    } catch (error) {
      stats.error = error.message;
      console.error(`❌ Radar source ${source.key} failed:`, error.message);
    }
    perSource[source.key] = stats;
  }

  let ingest = null;
  if (signals.length && !dryRun) {
    const payload = signals.map(({ __hash, ...s }) => s);
    ingest = await postSignals(payload);
    for (const s of signals) markPosted(s.dedup_key, s.source, s.__hash);
  }

  // Scan-health telemetry (best-effort; never fails the scan). Keyed by scanner.
  if (!dryRun) {
    const reports = Object.entries(perSource).map(([key, s]) => ({
      source: key,
      scanned_at: scannedAtIso,
      items_found: s.queued,
      ok: !s.error,
      note: s.error
        ? `error: ${s.error}`
        : `scanned ${s.scanned}, skipped ${s.skipped} (type ${s.type})`,
    }));
    await postScanReports(reports);
  }

  const summary = {
    ok: true,
    dryRun,
    queued: signals.length,
    sources: perSource,
    ingest,
    tookMs: Date.now() - startedAt,
  };
  console.log(
    `📡 Radar scan done: queued ${signals.length}${dryRun ? ' (dry-run)' : ''}`,
    JSON.stringify(perSource)
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Scheduling — daily at SCAN_HOUR (Europe/Amsterdam), self-realigning.
// ---------------------------------------------------------------------------

function msUntilNextScan() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const h = get('hour') % 24;
  const m = get('minute');
  const s = get('second');
  let secs = (SCAN_HOUR - h) * 3600 - m * 60 - s;
  if (secs <= 0) secs += 24 * 3600;
  return secs * 1000;
}

let scheduled = false;

export function startRadarScheduler() {
  if (scheduled) return;
  scheduled = true;
  try {
    initRadarDb();
  } catch (error) {
    console.error('❌ Radar DB init failed:', error.message);
  }

  const arm = () => {
    const delay = msUntilNextScan();
    setTimeout(async () => {
      try {
        await runRadarScan();
      } catch (error) {
        console.error('❌ Radar scheduled scan failed:', error.message);
      }
      arm();
    }, delay);
    console.log(`📡 Radar scheduled: next scan in ${Math.round(msUntilNextScan() / 3600000)}h (target ${SCAN_HOUR}:00 Europe/Amsterdam)`);
  };
  arm();
}

export { radarHealth };
