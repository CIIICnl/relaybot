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

```bash
# 1. Local: commit and push
cd ~/Github\ NW/ciiic-automator
git add -A && git commit -m "Description of changes" && git push

# 2. Server: pull and rebuild
ssh root@slidesbuilder
cd /opt/relaybot
git pull
docker compose up -d --build
```

Or use the deploy script from local:
```bash
ssh root@slidesbuilder 'cd /opt/relaybot && git pull && docker compose up -d --build'
```

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
