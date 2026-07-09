/**
 * Radar signals — configuration + v1 source allowlist.
 *
 * The relay scans this allowlist daily, extracts event candidates, dedups them
 * and POSTs them to the monitor Radar ingest endpoint. Monitor owns the store
 * (`monitor_signals`) and the promote-to-Notion action; the relay never writes
 * to Notion here. See:
 *   - monitor/docs/todos/radar-signals-design.md
 *   - _meta/.../from-monitor--to-ciiic-automator--radar-signals-ingest.md
 *   - docs/radar-source-recon-2026-07-09.md (which sources are machine-readable)
 */

// Ingest endpoint on monitor (contract: POST { signals: [...] }, bearer auth).
export const INGEST_URL =
  process.env.RADAR_INGEST_URL || 'https://monitor.ciiic.nl/api/radar/ingest';

// Shared bearer secret with monitor (RADAR_INGEST_SECRET, must match both sides).
export const INGEST_SECRET = process.env.RADAR_INGEST_SECRET || '';

// Relevance floor for POSTing at all. Monitor shows >= 50 in the default inbox;
// we post a bit lower so borderline items are still available under the fold,
// but drop clear noise to save ingest volume. Override via RADAR_RELEVANCE_FLOOR.
export const RELEVANCE_FLOOR = Number(process.env.RADAR_RELEVANCE_FLOOR ?? 30);

// Cap on new/changed items processed per source per run (guards LLM cost and a
// runaway first run against XRMust's 4600-event backlog). Override per env.
export const MAX_ITEMS_PER_SOURCE = Number(process.env.RADAR_MAX_PER_SOURCE ?? 40);

// Daily scan time (local Europe/Amsterdam hour, 24h). Override via RADAR_SCAN_HOUR.
export const SCAN_HOUR = Number(process.env.RADAR_SCAN_HOUR ?? 7);

// Local seen-store / watermark DB (Docker volume at /data).
export const DB_PATH = process.env.RADAR_DB_PATH || '/data/radar.sqlite';

// A descriptive UA so source operators can identify the scanner.
export const USER_AGENT =
  process.env.RADAR_USER_AGENT || 'ciiic-radar/1.0 (+https://bot.ciiic.nl)';

/**
 * v1 allowlist — machine-readable sources first (see recon note). Each entry:
 *   key       stable source key sent as `source` in the signal
 *   label     human name (logs)
 *   method    api | csv | rss   (scrape sources are phase 1b)
 *   enabled   toggle without code change
 */
export const SOURCES = [
  {
    key: 'xrmust',
    label: 'XRMust — XR Agenda',
    method: 'api',
    // WP REST custom post type; incremental via orderby=modified.
    apiBase: 'https://xrmust.com/wp-json/wp/v2/all-events',
    enabled: true,
  },
  {
    key: 'immersive-filmmaking-sheet',
    label: 'Immersive Filmmaking Calendar (Google Sheet)',
    method: 'csv',
    sheetId: '1kFw_-vefPcqAVVZOaw5YeK67IH7JiaTS2RH9lWNr4hk',
    // Empty = export the first (default) tab; the first tab's gid is NOT 0 here,
    // and export?format=csv&gid=0 400s. Set RADAR_SHEET_GID to target another tab.
    gid: process.env.RADAR_SHEET_GID || '',
    enabled: true,
  },
  {
    key: 'immersive-wire',
    label: 'Immersive Wire (Tom Ffiske)',
    method: 'rss',
    // The beehiiv feed. immersivewire.com/rss-feed is a human landing page, not XML.
    rssUrl: process.env.RADAR_IMMERSIVEWIRE_RSS || 'https://rss.beehiiv.com/feeds/7CIsY61ym3.xml',
    // Disabled in v1: the RSS works, but issues are news digests and single-event
    // extraction is unreliable (verified: it mis-dated a marginal mention). Needs a
    // multi-event extractor (phase 1b). Flip on via RADAR_ENABLE_IMMERSIVEWIRE=1.
    enabled: process.env.RADAR_ENABLE_IMMERSIVEWIRE === '1',
  },
];

export function enabledSources() {
  return SOURCES.filter((s) => s.enabled);
}

export function isConfigured() {
  return Boolean(INGEST_SECRET);
}
