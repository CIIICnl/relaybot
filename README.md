# CIIIC Relaybot

Email-to-Notion relay bot. Receives emails, uses AI to extract relevant info, creates items in Notion, and sends Zapier notifications.

## Email Routing

All emails to `*@bot.ciiic.nl` are handled by a single webhook that routes based on recipient:

| Email Address | Type | Notion Database | Description |
|---------------|------|-----------------|-------------|
| `events@bot.ciiic.nl` | `event` | Events | Calendar events with date, time, venue |
| `nieuwsbriefitem@bot.ciiic.nl` | `newsletter-item` | Content | Newsletter items, auto-linked to "Nieuwsbrief week X" |
| `*@bot.ciiic.nl` (anything else) | `inbox` | Inbox | Catch-all for misc items |

## Zapier Notifications

All item types send a webhook to Zapier with:

```json
{
  "type": "event" | "newsletter-item" | "inbox",
  "title": "Item title",
  "description": "Meta description of who sent what",
  "notionUrl": "https://notion.so/..."
}
```

## Deploying Updates

**Host:** `bot.ciiic.nl` runs as the Coolify app **`relaybot`** on
`ciiic-coolify` (`51.15.131.87`), managed at `https://coolify.ciiic.nl`.
Coolify **auto-deploys on every push to `main`** — there is no manual
SSH/rebuild step.

```bash
# Commit and push — Coolify redeploys relaybot on push to main
cd ~/Github\ NW/ciiic-automator
git add -A && git commit -m "Description of changes" && git push
```

Verify live via `https://bot.ciiic.nl/health`.

**Secrets / env vars** are set in the Coolify dashboard (relaybot app →
Environment Variables), then **Redeploy** — not in a `.env` file on a server.

> ⚠️ **Ignore `51.158.116.31 /opt/relaybot`.** That box (Scaleway Paris,
> hostname `slidesbuilder`) is only a Caddy front proxy that forwards
> `bot.ciiic.nl` on to the Coolify host. Its local `ciiic-automator` container
> is stale and receives no production traffic — deploying there does nothing for
> prod. (Verified 2026-07-09; the old manual-Docker flow lived here.)

## Environment Variables

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
NOTION_SECRET=ntn_...
NOTION_EVENTS_DATABASE_ID=...
NOTION_CONTENT_DATABASE_ID=...
NOTION_INBOX_DATABASE_ID=...
BREVO_API_KEY2=xkeysib-...
ZAPIER_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/...
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info |
| `GET /health` | Health check with API status |
| `POST /webhook/email` | Unified email webhook (routes by recipient) |
| `POST /webhook/test` | Test with raw JSON (use `to` field for routing) |
| `POST /draft/save` | Save a Publieke Waarden Zelftoets draft; emails a magic resume link |
| `GET /draft/:token` | Fetch a saved draft by its token |
| `POST /intake/ticket` | Create a Notion ticket from the chatbot (bearer auth) |
| `POST /radar/scan` | Trigger a radar source scan → monitor ingest (bearer auth; `?dryRun=1`, `?only=`) |

## Draft-Resume (Publieke Waarden Zelftoets)

Used by [publicvalues.ciiic.nl](https://publicvalues.ciiic.nl) to let visitors
save an in-progress self-assessment and resume via an emailed magic link.

- **Retention:** drafts are purged 30 days after creation. The DB lives at
  `/data/drafts.sqlite` inside the container; mount a Docker volume so the
  file survives rebuilds (see `docker-compose.yml`).
- **Auth model:** the token in the emailed link *is* the auth. Anyone with
  the token can read that draft.
- **CORS:** only `https://publicvalues.ciiic.nl` and `http://localhost:4321`
  may call the endpoints.
- **Rate limits on `POST /draft/save`:** 5 per IP per 15 min, 3 per email
  per hour.

## Intake Ticket Endpoint (chatbot → Notion)

`POST /intake/ticket` lets the chatbot (`ciiicbot`, ai.ciiic.nl) log a user's
request as a ticket in the Notion database **"Website 2026 bugs &
doorontwikkeling"** (`34b11fb0-8c9e-803b-aedd-e3d19964c8a1`). The relay owns the
Notion token and the identity mapping; the chatbot only holds the shared secret.

**Auth:** bearer token in the `Authorization` header, matched against the
`INTAKE_TOKEN` env var. Missing/wrong token → `401`; unset on the server → `503
intake_not_configured`.

**Request body (JSON):**

| Field | Required | Notes |
|-------|----------|-------|
| `issue` | ✅ | Short title → Notion `Issue` (title) |
| `beschrijving` | ✅ | Full description → `Issuebeschrijving` |
| `type` | – | `Bug` \| `Doorontwikkeling` \| `Verzoek` (default `Verzoek`) |
| `systeem` | – | `Website` \| `Beeldbank` \| `Chatbot` \| `Overig` |
| `prioriteit` | – | `Hoog` \| `Middel` \| `Laag` |
| `url` | – | Relevant page/URL → Notion `url` property |
| `indiener_email` | – | Resolved to a Notion user for `Ingediend door` |
| `indiener_naam` | – | Fallback attribution when the user can't be resolved |

`Status` is left at its Notion default (`Nieuw` / Not started).

**Identity resolution (`Ingediend door`):** `indiener_email` is matched
(case-insensitively) against the Notion users list. An override map handles
people whose chatbot email differs from their Notion email (e.g. **Heleen**, who
is on Notion with a Gmail address). Overrides live in
`src/config/email-overrides.json` and can be extended via the
`INTAKE_EMAIL_OVERRIDES` env var (JSON object). If the submitter can't be
resolved, the ticket is **still created** with `Ingediend door` empty and the
name/email appended to `Issuebeschrijving` — intake never fails on an unknown
submitter.

**Example:**

```bash
curl -X POST https://bot.ciiic.nl/intake/ticket \
  -H "Authorization: Bearer $INTAKE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "issue": "Kaart laadt niet op agenda-pagina",
    "beschrijving": "Gebruiker meldt via de chatbot dat de kaart leeg blijft in Safari.",
    "type": "Bug",
    "systeem": "Website",
    "prioriteit": "Middel",
    "url": "https://ciiic.nl/agenda",
    "indiener_email": "iemand@ciiic.nl",
    "indiener_naam": "Iemand"
  }'
```

**Response:**

```json
{
  "ok": true,
  "success": true,
  "notionUrl": "https://www.notion.so/...",
  "ticketId": "…",
  "ingediendDoorResolved": true
}
```

**Env vars:**

```env
INTAKE_TOKEN=<shared bearer secret with ciiicbot>
# optional overrides:
NOTION_BUGS_DATABASE_ID=34b11fb0-8c9e-803b-aedd-e3d19964c8a1
INTAKE_EMAIL_OVERRIDES={"heleen@ciiic.nl":"heleen.private@gmail.com"}
```

> The relay's Notion integration (`NOTION_SECRET`) must be granted access to the
> bugs database in Notion (share the DB → Connections → add the integration).

## Radar Signals (source scan → monitor)

The relay scans a small allowlist of immersive/XR sources daily, extracts
candidates with an LLM, dedups them, and POSTs them to the **monitor** Radar
ingest endpoint (`POST monitor.ciiic.nl/api/radar/ingest`) with a `type` of
`event`, `research` or `funding`. Monitor owns the `monitor_signals` store and the
promote-to-Notion action; **the relay never writes to Notion here.** See
`docs/radar-source-recon-2026-07-09.md` (events) and
`docs/radar-fase2-recon-2026-07-09.md` (research + funding) for per-source feed
reality, and `src/services/radar/`.

**Sources** (machine-readable first — verified live). Scrape / newsletter-LLM
sources are scaffolded off behind flags until hardened (see the recon docs).

| Type | Source | Method | Status |
|------|--------|--------|--------|
| event | XRMust XR Agenda | WP REST API + per-event page fetch | ✅ on |
| event | Immersive Filmmaking Calendar | Google Sheet CSV | ✅ on |
| event | Immersive Wire | beehiiv RSS | ⏸️ off (`RADAR_ENABLE_IMMERSIVEWIRE=1`) |
| research | arXiv cs.HC + cs.GR | Atom API | ✅ on |
| research | Frontiers in VR, Elsevier C&G | RSS | ✅ on |
| research | Springer VR, Nature Scientific Reports | RSS | ⏸️ off — block server-side fetch with a JS challenge; need a headless/proxy fetch (`RADAR_ENABLE_SPRINGER=1`/`RADAR_ENABLE_NATURE=1`) |
| research | EurekAlert, Immerse, Voices of VR | RSS / newsletter | ⏸️ off (phase 2b) |
| funding | EU Funding & Tenders | SEDIA search-API | ✅ on (`eu-sedia`) |
| funding | national funds (Filmfonds, CNC, Medienboard, …) | page-scrape | ⏸️ off (phase 2b) |

**Date semantics per type:** event → start date; research → publication date;
funding → **deadline** (with `extra.status` = open/closed/upcoming).

**Pipeline:** scan (incremental, watermark per source) → type-specific LLM extract +
relevance score (0-100, NL/public-values weighted) → drop below
`RADAR_RELEVANCE_FLOOR`, already-in-Event-Calendar (events only), or
unchanged-since-last-post → batch POST to monitor → per-source scan-health POST to
`/api/radar/scan-report` → Slack digest of brand-new items. `dedup_key` follows the
monitor seed convention (normalized canonical URL) so daily scans land on
already-seeded rows. State (watermarks + seen dedup_keys) lives in `/data/radar.sqlite`.

**Slack digest:** after each scan the relay posts the brand-new signals (dedup_key
never seen before, so no re-notifies) to `RADAR_SLACK_CHANNEL` (default
`#team-ciiic`) via the existing `SLACK_BOT_TOKEN`, deep-linking to the monitor
inbox. The first run primes silently so the backfill doesn't flood the channel;
set `RADAR_SLACK_DIGEST=0` to disable. The bot must be invited to the channel.

**Schedule:** daily at `RADAR_SCAN_HOUR` (Europe/Amsterdam, default 07:00), plus a
manual trigger:

```bash
# dry-run (extract + dedup, no POST, no watermark advance)
# ?only= restricts to one source; ?type=research|funding|event restricts to one type
curl -X POST "https://bot.ciiic.nl/radar/scan?dryRun=1&type=funding" \
  -H "Authorization: Bearer $RADAR_INGEST_SECRET"
```

**Env:** `RADAR_INGEST_SECRET` (shared with monitor) enables the scheduler and
endpoint; see `.env.example` for the optional tuning knobs. `/health` reports
`radar.configured`.

## Testing Locally

```bash
npm install
npm start

# Test event
curl -X POST http://localhost:3000/webhook/test \
  -H "Content-Type: application/json" \
  -d '{
    "from": "you@example.com",
    "to": "events@bot.ciiic.nl",
    "subject": "Tech Meetup",
    "body": "Join us March 15, 2025 at 18:00 at WeWork Amsterdam"
  }'

# Test newsletter item
curl -X POST http://localhost:3000/webhook/test \
  -H "Content-Type: application/json" \
  -d '{
    "from": "you@example.com",
    "to": "nieuwsbriefitem@bot.ciiic.nl",
    "subject": "Fwd: Cool article",
    "body": "Check this out! https://example.com/article"
  }'

# Test inbox (catch-all)
curl -X POST http://localhost:3000/webhook/test \
  -H "Content-Type: application/json" \
  -d '{
    "from": "you@example.com",
    "to": "random@bot.ciiic.nl",
    "subject": "Some email",
    "body": "This goes to inbox"
  }'
```

## Brevo Inbound Email Setup

Emails are routed via Brevo Inbound Parsing:
- MX record: `bot.ciiic.nl` → `inbound-smtp.brevo.com`
- Webhook: `https://bot.ciiic.nl/webhook/email`
- Config: https://app.brevo.com/settings/inbound-parsing
