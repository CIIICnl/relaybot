# CLAUDE.md — CIIIC Relaybot

Node/Express relay service deployed as **`bot.ciiic.nl`**. Two jobs:

1. **Email/Slack → Notion** — receives inbound email at `*@bot.ciiic.nl`,
   uses AI to extract structured fields, and creates pages in the right
   Notion database (Events, Content, Inbox). Zapier webhook on each item.
2. **Jaarevent 2026 registration sync** — receives Gravity Forms webhooks
   from Form 13 and keeps Mailchimp `JAAREVENT` + Notion Contacten
   (`jaarevent-2026` property) in sync with registration status.

- **Live host:** Coolify app **`relaybot`** on `ciiic-coolify` (`51.15.131.87`),
  managed at `https://coolify.ciiic.nl`. This is what actually serves
  `bot.ciiic.nl`.
- **Runs as:** a Coolify-managed Docker container behind Caddy.
- **Upstream repo:** `CIIICnl/ciiic-automator` (hernoemd van `relaybot`, 2026-07-12)
- **Deploy trigger:** push to `main` → Coolify auto-deploys. No manual step.
- **Secrets/env:** set in the Coolify UI (relaybot app → Environment Variables),
  **not** in a `.env` file on a server.

> ⚠️ **Not** `51.158.116.31 /opt/relaybot`. That box is only a Caddy front proxy
> that forwards `bot.ciiic.nl` (+ beeldbank/dashboard/monitor/go/links) on to the
> Coolify host. It runs a stale `ciiic-automator` container that receives no
> production traffic; deploying there is a no-op for prod. (Verified 2026-07-09.)

## Deploy

```bash
cd ~/Github\ NW/ciiic-automator
git add -A && git commit -m "…" && git push   # → Coolify redeploys relaybot on push to main
```

Verify live via `https://bot.ciiic.nl/health`. Env changes (e.g. new secrets) go
through the Coolify dashboard, then Redeploy.

## Shared knowledge base

Cross-project CIIIC background lives in the **[CIIIC-KB](../CIIIC-KB/)**
Obsidian vault (`../CIIIC-KB/`, mirrored to `CIIICnl/CIIIC-KB` on GitHub).
Read `../CIIIC-KB/_index.md` for the full map.

| Path | Load when |
|---|---|
| `../CIIIC-KB/applications/relaybot.md` | Background briefing on this app — webhook routes, state machine, known sync gaps |
| `../CIIIC-KB/applications/jaarevent-2026.md` | Jaarevent 2026 registration pipeline — who writes what into Forms, Mailchimp, Notion, dashboard |
| `../CIIIC-KB/applications/forms.md` | Gravity Forms on `forms.ciiic.nl` — Form 13 schema, check-in endpoint, track segments |
| `../CIIIC-KB/applications/dashboard.md` | Downstream consumer — dashboard pulls Form 13 via `npm run sync`; don't change webhook semantics without coordinating |
| `../CIIIC-KB/systems/notion-architecture.md` | Target databases (Events, Content, Inbox, Contacten) and property formats |
| `../CIIIC-KB/organization/ciiic-overview.md` | Context on CIIIC itself, audiences, actielijnen |

## Notion property formats

See Jaap's global `~/.claude/CLAUDE.md` for the SDK v5 / 2025-09-03
`database_id` vs `data_source_id` rules and the SQLite-style property
value map (checkbox `__YES__`/`__NO__`, relation as JSON URL array,
etc.). All writes from this bot must use that format.

## Email routing

| Address | Type | Notion DB |
|---|---|---|
| `events@bot.ciiic.nl` | `event` | Events |
| `nieuwsbriefitem@bot.ciiic.nl` | `newsletter-item` | Content (auto-linked to "Nieuwsbrief week X") |
| `*@bot.ciiic.nl` (other) | `inbox` | Inbox |

If the routing table changes, update both here and
`../CIIIC-KB/applications/relaybot.md`.

## Workspace convention

Feature work happens **from this directory**. `jaap-work` is the
cross-system debugging workspace (has all credentials and docs in one
place) but shouldn't hold production code.
