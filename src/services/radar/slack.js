/**
 * Radar Slack digest — after each daily scan, post the brand-new signals to a
 * Slack channel (#team-ciiic) via chat.postMessage, using the relay's existing
 * SLACK_BOT_TOKEN. "Brand-new" = a dedup_key never seen before (store.seenState),
 * so updates to already-known items don't re-notify.
 *
 * Config (env):
 *   SLACK_BOT_TOKEN      required — the bot must be invited to the channel and
 *                        have chat:write scope.
 *   RADAR_SLACK_CHANNEL  channel name or id (default '#team-ciiic').
 *   RADAR_SLACK_DIGEST   set to '0' to disable posting (kill switch).
 *   MONITOR_RADAR_URL    deep-link target (default 'https://monitor.ciiic.nl/radar').
 *
 * Best-effort: a failed post never fails the scan (logged, swallowed).
 */

import { USER_AGENT } from './config.js';

const TYPE_LABEL = { event: 'Events', research: 'Onderzoek', funding: 'Funding', news: 'Nieuws' };
const TYPE_ORDER = ['event', 'research', 'funding', 'news'];
const MAX_PER_TYPE = 8;

/** Escape the three characters Slack treats specially in mrkdwn text spans. */
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function line(signal) {
  const title = esc(signal.title).slice(0, 200);
  const linked = signal.url ? `<${signal.url}|${title}>` : title;
  let detail = '';
  if (signal.type === 'funding') {
    const status = typeof signal.extra?.status === 'string' ? signal.extra.status : null;
    detail = ` — deadline ${signal.event_date || '?'}${status ? ` (${status})` : ''}`;
  } else if (signal.type === 'event') {
    detail = signal.event_date ? ` — ${signal.event_date}` : '';
  } else if (signal.relevance != null) {
    detail = ` — relevantie ${signal.relevance}`;
  }
  return `• ${linked}${detail}`;
}

export function buildDigestText(fresh) {
  const monitorUrl = process.env.MONITOR_RADAR_URL || 'https://monitor.ciiic.nl/radar';
  const n = fresh.length;
  const lines = [`🛰️ *Radar: ${n} nieuw${n === 1 ? '' : 'e'} signal${n === 1 ? '' : 'en'} vandaag*`];

  for (const type of TYPE_ORDER) {
    const items = fresh.filter((s) => s.type === type);
    if (!items.length) continue;
    lines.push(`\n*${TYPE_LABEL[type]} (${items.length})*`);
    for (const s of items.slice(0, MAX_PER_TYPE)) lines.push(line(s));
    if (items.length > MAX_PER_TYPE) lines.push(`  …en nog ${items.length - MAX_PER_TYPE}`);
  }
  lines.push(`\nBekijk alles: <${monitorUrl}|${monitorUrl.replace(/^https?:\/\//, '')}>`);
  return lines.join('\n');
}

export async function postRadarDigest(fresh) {
  if (process.env.RADAR_SLACK_DIGEST === '0') return { skipped: 'disabled' };
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { skipped: 'no_token' };
  const channel = process.env.RADAR_SLACK_CHANNEL || '#team-ciiic';
  if (!Array.isArray(fresh) || fresh.length === 0) return { skipped: 'empty' };

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        channel,
        text: buildDigestText(fresh),
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      console.error('⚠️ Radar Slack digest failed:', json.error || `HTTP ${res.status}`);
      return { ok: false, error: json.error || `HTTP ${res.status}` };
    }
    console.log(`📮 Radar Slack digest posted (${fresh.length} items) to ${channel}`);
    return { ok: true, ts: json.ts };
  } catch (error) {
    console.error('⚠️ Radar Slack digest threw:', error.message);
    return { ok: false, error: error.message };
  }
}
