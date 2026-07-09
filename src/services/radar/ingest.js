/**
 * Radar ingest client — POST candidate signals to monitor's /api/radar/ingest.
 *
 * Contract (monitor/src/routes/api/radar/ingest/+server.ts):
 *   POST { signals: [ { source, source_url?, type, title, summary?, url?,
 *          event_date?, extra?, relevance?, dedup_key } ] }
 *   Bearer auth (RADAR_INGEST_SECRET). Max 500 per request.
 *   Response: { ok, received, inserted, updated }.
 */

import { INGEST_URL, INGEST_SECRET, USER_AGENT } from './config.js';

const BATCH_SIZE = 500;

export async function postSignals(signals) {
  if (!INGEST_SECRET) throw new Error('RADAR_INGEST_SECRET not configured');
  const totals = { received: 0, inserted: 0, updated: 0, batches: 0 };

  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    const batch = signals.slice(i, i + BATCH_SIZE);
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INGEST_SECRET}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ signals: batch }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ingest HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let json = {};
    try { json = JSON.parse(text); } catch { /* tolerate */ }
    totals.received += json.received || batch.length;
    totals.inserted += json.inserted || 0;
    totals.updated += json.updated || 0;
    totals.batches += 1;
  }

  return totals;
}
