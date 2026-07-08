import { readFileSync } from 'node:fs';
import { Client } from '@notionhq/client';

/**
 * Intake ticket service.
 *
 * Creates a ticket in the Notion database "Website 2026 bugs & doorontwikkeling"
 * (broadened post-launch to a single entry point for all technical requests to
 * Jaap: bugs, doorontwikkeling and verzoeken). Called by the chatbot (ciiicbot)
 * via POST /intake/ticket so it can offer to log a user's request as a ticket.
 *
 * Reuses the existing relay Notion integration (NOTION_SECRET). The integration
 * must have access to the target database (share the DB with it in Notion).
 */

const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

// Container database-id of "Website 2026 bugs & doorontwikkeling".
// Overridable via env; defaults to the known id from
// website-prototypes/docs/reference/notion-bug-database.md.
const BUGS_DATABASE_ID =
  process.env.NOTION_BUGS_DATABASE_ID || '34b11fb0-8c9e-803b-aedd-e3d19964c8a1';

// Allowed select values (see the schema doc). Kept in sync manually with Notion.
export const TICKET_TYPES = ['Bug', 'Doorontwikkeling', 'Verzoek'];
export const TICKET_SYSTEMS = ['Website', 'Beeldbank', 'Chatbot', 'Overig'];
export const TICKET_PRIORITIES = ['Hoog', 'Middel', 'Laag'];
const DEFAULT_TYPE = 'Verzoek';

// Notion rich_text / title field limit per text node.
const NOTION_TEXT_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Email -> Notion user resolution (with config-driven overrides)
// ---------------------------------------------------------------------------

/**
 * Load the chatbot-email -> notion-email override map.
 * Sources (later wins):
 *   1. src/config/email-overrides.json (keys starting with "_" are ignored)
 *   2. INTAKE_EMAIL_OVERRIDES env var (JSON object string)
 * Both keys and values are lowercased.
 */
function loadEmailOverrides() {
  const map = {};

  try {
    const fileUrl = new URL('../config/email-overrides.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('_')) continue; // doc/example entries
      if (typeof value === 'string') map[key.toLowerCase()] = value.toLowerCase();
    }
  } catch (error) {
    console.error('⚠️ Could not read email-overrides.json:', error.message);
  }

  if (process.env.INTAKE_EMAIL_OVERRIDES) {
    try {
      const parsed = JSON.parse(process.env.INTAKE_EMAIL_OVERRIDES);
      for (const [key, value] of Object.entries(parsed)) {
        map[key.toLowerCase()] = String(value).toLowerCase();
      }
    } catch (error) {
      console.error('⚠️ Invalid INTAKE_EMAIL_OVERRIDES JSON, ignoring:', error.message);
    }
  }

  return map;
}

// Cache the Notion users list (email -> id). Users rarely change; refresh hourly.
let usersCache = null;
let usersCacheAt = 0;
const USERS_CACHE_TTL_MS = 60 * 60 * 1000;

async function getUsersByEmail() {
  const now = Date.now();
  if (usersCache && now - usersCacheAt < USERS_CACHE_TTL_MS) {
    return usersCache;
  }

  const map = {};
  let cursor;
  do {
    const res = await notion.users.list({ start_cursor: cursor, page_size: 100 });
    for (const user of res.results) {
      const email = user.type === 'person' ? user.person?.email : null;
      if (email) map[email.toLowerCase()] = user.id;
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  usersCache = map;
  usersCacheAt = now;
  return map;
}

/**
 * Resolve a submitter email to a Notion user-id, applying the override map.
 * Returns null when the email is missing or no matching Notion user is found.
 * Never throws — resolution failure must not block ticket creation.
 */
async function resolveNotionUserId(email) {
  if (!email || typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  try {
    const overrides = loadEmailOverrides();
    const target = overrides[normalized] || normalized;
    const byEmail = await getUsersByEmail();
    return byEmail[target] || null;
  } catch (error) {
    console.error('⚠️ Notion user resolution failed:', error.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ticket creation
// ---------------------------------------------------------------------------

function clip(text) {
  return String(text ?? '').slice(0, NOTION_TEXT_LIMIT);
}

/**
 * Create an intake ticket in the bugs/doorontwikkeling database.
 *
 * @param {Object} input
 * @param {string}  input.issue         Short title (required)
 * @param {string}  input.beschrijving  Full description (required)
 * @param {string} [input.type]         Bug | Doorontwikkeling | Verzoek (default Verzoek)
 * @param {string} [input.systeem]      Website | Beeldbank | Chatbot | Overig
 * @param {string} [input.prioriteit]   Hoog | Middel | Laag
 * @param {string} [input.url]          Relevant page/URL
 * @param {string} [input.indiener_email]
 * @param {string} [input.indiener_naam]
 * @returns {Promise<{id:string,url:string,ingediendDoorResolved:boolean}>}
 */
export async function createTicket(input) {
  const {
    issue,
    beschrijving,
    type,
    systeem,
    prioriteit,
    url,
    indiener_email,
    indiener_naam,
  } = input;

  const userId = await resolveNotionUserId(indiener_email);
  const ingediendDoorResolved = Boolean(userId);

  // If we could not link the submitter to a Notion user, keep their name/email
  // in the description so Jaap can attribute the ticket manually.
  let description = String(beschrijving);
  if (!ingediendDoorResolved && (indiener_naam || indiener_email)) {
    const who = [indiener_naam, indiener_email].filter(Boolean).join(' ');
    description += `\n\nIngediend door (niet gekoppeld in Notion): ${who}`;
  }

  const properties = {
    Issue: {
      title: [{ text: { content: clip(issue) } }],
    },
    Issuebeschrijving: {
      rich_text: [{ text: { content: clip(description) } }],
    },
    Type: {
      select: { name: type || DEFAULT_TYPE },
    },
  };

  if (systeem) properties.Systeem = { select: { name: systeem } };
  if (prioriteit) properties.Prioriteit = { select: { name: prioriteit } };
  if (url) properties.url = { url };
  if (userId) properties['Ingediend door'] = { people: [{ id: userId }] };

  const response = await notion.pages.create({
    parent: { database_id: BUGS_DATABASE_ID },
    properties,
  });

  return {
    id: response.id,
    url: response.url,
    ingediendDoorResolved,
  };
}

/**
 * Test connectivity to the bugs database (used by /health).
 */
export async function testConnection() {
  try {
    const database = await notion.databases.retrieve({
      database_id: BUGS_DATABASE_ID,
    });
    return {
      success: true,
      databaseTitle: database.title?.[0]?.plain_text || 'Unknown',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
