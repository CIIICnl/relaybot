# CIIIC Event Automator - Setup Guide

This application receives forwarded emails, uses AI to extract event information, and creates events in your Notion calendar.

## Quick Start

```bash
npm install
npm start
```

Server runs on port 3000 (configurable via `PORT` env var).

## Required Environment Variables

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
NOTION_EVENTS_DATABASE_ID=your-database-id
NOTION_SECRET=ntn_...
BREVO_API_KEY2=xkeysib-...  # For sending reply emails
```

## Setting Up Email Routing for events@bot.ciiic.nl

You need an inbound email service that forwards emails to your webhook. Here are three options:

### Option 1: Mailgun (Recommended)

1. **Create Mailgun account** at https://www.mailgun.com (free tier: 5,000 emails/month)

2. **Add your domain** `bot.ciiic.nl` in Mailgun

3. **Configure DNS for bot.ciiic.nl**:
   ```
   MX   bot.ciiic.nl   10  mxa.mailgun.org
   MX   bot.ciiic.nl   10  mxb.mailgun.org
   TXT  bot.ciiic.nl   v=spf1 include:mailgun.org ~all
   ```

4. **Create a Route** in Mailgun → Receiving → Routes:
   - Expression type: Match Recipient
   - Recipient: `events@bot.ciiic.nl`
   - Actions: Forward → `https://your-server.com/webhook/email`
   - Check "Store and notify"

### Option 2: SendGrid Inbound Parse

1. **Create SendGrid account** at https://sendgrid.com

2. **Configure DNS for bot.ciiic.nl**:
   ```
   MX   bot.ciiic.nl   10  mx.sendgrid.net
   ```

3. **Set up Inbound Parse** in SendGrid → Settings → Inbound Parse:
   - Hostname: `bot.ciiic.nl`
   - URL: `https://your-server.com/webhook/email`
   - Check "POST the raw, full MIME message"

### Option 3: Brevo Inbound Parsing (Recommended - already have account)

1. **Go to** https://app.brevo.com/settings/inbound-parsing

2. **Add your domain** `bot.ciiic.nl`

3. **Configure DNS for bot.ciiic.nl**:
   ```
   MX   bot.ciiic.nl   10  inbound-smtp.brevo.com
   ```

4. **Set webhook URL** to: `https://bot.ciiic.nl/webhook/email`

## Deploying to Scaleway VPS

Same pattern as slides.ciiic.nl - Docker Compose with Caddy for auto-HTTPS.

### 1. Create DNS Records

Add to your DNS:
```
A    bot.ciiic.nl   → your-vps-ip
MX   bot.ciiic.nl   10  inbound-smtp.brevo.com
```

### 2. Deploy on VPS

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Create directory for the service
mkdir -p /opt/ciiic-automator
cd /opt/ciiic-automator

# Clone the repo
git clone https://github.com/your-org/ciiic-automator.git .

# Create .env file with your keys
cp .env.example .env
nano .env  # Edit with your actual values

# Start the service
docker compose up -d --build
```

### 3. Verify Deployment

```bash
# Check logs
docker compose logs -f

# Test health endpoint
curl https://bot.ciiic.nl/health
```

### Updating

```bash
cd /opt/ciiic-automator
git pull
docker compose up -d --build
```

### Port Conflicts (if 80/443 already in use)

If another Caddy is already using ports 80/443, add bot.ciiic.nl to the existing Caddyfile instead:

```caddy
bot.ciiic.nl {
  encode gzip
  reverse_proxy ciiic-automator-app:3000
}
```

And remove the caddy service from this docker-compose.yml, connecting to the shared network instead.

## Brevo IP Whitelisting

If you get 401 errors from Brevo, add your server's IP address:
https://app.brevo.com/security/authorised_ips

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info |
| `/health` | GET | Health check with API status |
| `/webhook/email` | POST | Inbound email webhook (auto-detects format) |
| `/webhook/test` | POST | Test with raw JSON `{from, subject, body}` |

## Testing

Test the webhook locally:

```bash
curl -X POST http://localhost:3000/webhook/test \
  -H "Content-Type: application/json" \
  -d '{
    "from": "you@example.com",
    "subject": "Event: Tech Meetup",
    "body": "Join us for a tech meetup!\n\nDate: March 15, 2025\nTime: 18:00-20:00\nLocation: WeWork Amsterdam\n\nRegister: https://example.com/register"
  }'
```

## How It Works

1. **Email arrives** at events@bot.ciiic.nl
2. **Email service** (Mailgun/SendGrid/Postmark) POSTs to `/webhook/email`
3. **OpenAI** extracts event details (name, date, time, venue, URL, description)
4. **Notion** event is created in your calendar
5. **Brevo** sends confirmation email with Notion link to sender

## Supported Email Formats

The webhook auto-detects these formats:
- Brevo Inbound Parsing
- SendGrid Inbound Parse
- Mailgun
- Postmark
- Generic JSON `{from, subject, body/text/content}`

## Notion Properties Mapped

| Email Data | Notion Property |
|------------|-----------------|
| Event title | Event name (title) |
| Date/time | Event date (with optional end) |
| Location | Venue (rich_text) |
| URL | Event URL (url) |
| Description | Beschrijving (rich_text) |
| Auto-set | site / nieuwsbrief (checkbox, default: true) |
