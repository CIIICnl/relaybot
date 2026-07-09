/**
 * Radar orchestrator — daily scan → extract → dedup → ingest.
 *
 * For each enabled source: pull new/changed items (incremental via watermark),
 * LLM-extract + score each, drop below the relevance floor / already in the
 * Event Calendar / unchanged since last post, then batch-POST the survivors to
 * monitor's ingest endpoint. The relay never writes to Notion here.
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
import { extractEvent } from './extract.js';
import { normalizeDedupKey, loadExistingEventKeys, existsInCalendar } from './dedup.js';
import { postSignals } from './ingest.js';
import { scan as xrmustScan } from './sources/xrmust.js';
import { scan as sheetScan } from './sources/sheet.js';
import { scan as wireScan } from './sources/immersivewire.js';

const SCANNERS = {
  xrmust: xrmustScan,
  'immersive-filmmaking-sheet': sheetScan,
  'immersive-wire': wireScan,
};

function buildSignal(source, item, ex, dedupKey) {
  const extra = {
    event_end: ex.eventEnd,
    venue: ex.venue,
    thema: ex.thema,
    schaal: ex.schaal,
  };
  for (const k of Object.keys(extra)) if (extra[k] == null) delete extra[k];

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
    dedup_key: dedupKey,
  };
}

/**
 * Run one full radar scan.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] extract + dedup but do not POST or advance watermarks
 * @param {string}  [opts.only]   restrict to a single source key (testing)
 */
export async function runRadarScan({ dryRun = false, only = null } = {}) {
  const startedAt = Date.now();
  if (!isConfigured() && !dryRun) {
    return { ok: false, error: 'RADAR_INGEST_SECRET not configured' };
  }

  const calendarKeys = await loadExistingEventKeys();
  const perSource = {};
  const signals = [];

  for (const source of enabledSources()) {
    if (only && source.key !== only) continue;
    const stats = { scanned: 0, queued: 0, skipped: 0, error: null };
    try {
      const wm = getWatermark(source.key);
      const { watermark, items } = await SCANNERS[source.key](source, {
        watermark: wm,
        max: MAX_ITEMS_PER_SOURCE,
      });
      stats.scanned = items.length;

      for (const item of items) {
        const ex = await extractEvent(item.rawText, { hint: item.hint });
        if (!ex || !ex.isEvent || !ex.title) { stats.skipped++; continue; }
        if (ex.relevance != null && ex.relevance < RELEVANCE_FLOOR) { stats.skipped++; continue; }

        const dedupKey = normalizeDedupKey({
          canonicalUrl: ex.canonicalUrl,
          url: item.url,
          title: ex.title,
          eventDate: ex.eventDate,
        });
        if (existsInCalendar({ title: ex.title, eventDate: ex.eventDate }, calendarKeys)) {
          stats.skipped++;
          continue;
        }

        const signal = buildSignal(source, item, ex, dedupKey);
        const contentHash = hashContent(signal);
        if (isUnchanged(dedupKey, contentHash)) { stats.skipped++; continue; }

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

  const summary = {
    ok: true,
    dryRun,
    queued: signals.length,
    sources: perSource,
    ingest,
    tookMs: Date.now() - startedAt,
  };
  console.log(`📡 Radar scan done: queued ${signals.length}${dryRun ? ' (dry-run)' : ''}`, JSON.stringify(perSource));
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
