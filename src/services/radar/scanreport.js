/**
 * Radar scan-health client — POST per-source scan outcomes to monitor's
 * /api/radar/scan-report so the /radar/bronnen overview can show a second layer:
 * "scanned today / delivered N / feed ok?" for every source, including ones that
 * yielded nothing (which never reach the ingest endpoint at all).
 *
 * Contract agreed with the monitor agent (see the return briefing):
 *   POST { reports: [ { source, scanned_at, items_found, ok, note? } ] }
 *   Bearer auth (RADAR_INGEST_SECRET, shared with ingest). A single object
 *   without the wrapper is also accepted. Response: { ok, received }.
 *
 * Scan-health is keyed by the SCANNER (config source key). Funding signals may
 * carry per-programme source keys on the signal itself; the delivered-per-
 * programme breakdown is derivable monitor-side from the ingested rows.
 *
 * Best-effort: a failed scan-report never fails the scan (logged, swallowed).
 */

import { SCAN_REPORT_URL, INGEST_SECRET, USER_AGENT } from './config.js';

export async function postScanReports(reports) {
  if (!INGEST_SECRET || !Array.isArray(reports) || reports.length === 0) return null;
  try {
    const res = await fetch(SCAN_REPORT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INGEST_SECRET}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ reports }),
    });
    if (!res.ok) {
      const text = await res.text();
      // 404 is expected until the monitor endpoint ships — don't cry wolf.
      const level = res.status === 404 ? 'log' : 'warn';
      console[level === 'warn' ? 'error' : 'log'](
        `📡 scan-report HTTP ${res.status}${res.status === 404 ? ' (endpoint not deployed yet)' : `: ${text.slice(0, 200)}`}`
      );
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (error) {
    console.error('⚠️ scan-report post failed:', error.message);
    return { ok: false, error: error.message };
  }
}
