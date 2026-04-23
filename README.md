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

**Host:** `slidesbuilder` (Scaleway Paris, hostname resolves only on machines
with a local alias — use the IP `51.158.116.31` from anywhere else).
Connects with default SSH identities (1Password agent). Repo is at
`/opt/relaybot` and runs in Docker.

```bash
# 1. Local: commit and push
cd ~/Github\ NW/ciiic-automator
git add -A && git commit -m "Description of changes" && git push

# 2. Server: pull and rebuild
ssh root@51.158.116.31   # or 'root@slidesbuilder' if the alias resolves
cd /opt/relaybot
git pull
docker compose up -d --build
```

Or one-shot from local:
```bash
ssh root@51.158.116.31 'cd /opt/relaybot && git pull && docker compose up -d --build'
```

**Never hand-edit files on the server.** On 2026-04-14 a `jaarevent.js`
hotfix was applied in-place and the uncommitted change blocked a later
`git pull`. If a live patch is unavoidable, mirror the change in this
repo and push before the next deploy.

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
