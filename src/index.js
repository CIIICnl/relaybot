import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { parseEventFromEmail, parseNewsletterItemFromEmail, parseInboxItemFromEmail, extractUrls, fetchUrlContent } from './services/openai.js';
import { createEvent, createContentItem, createInboxItem, addComment, testConnection as testNotion } from './services/notion.js';
import { sendEventConfirmation, sendNewsletterItemConfirmation, sendErrorNotification, sendDraftResumeEmail, testConnection as testBrevo } from './services/brevo.js';
import { processRegistration, processStatusChange, processCheckin, verifySignature } from './services/jaarevent.js';
import { processSxswSubmission } from './services/sxsw.js';
import { initDraftsDb, saveDraft, getDraft, deleteDraft, purgeExpired, healthCheck as draftsHealth } from './services/drafts.js';
import { createTicket, testConnection as testIntake, TICKET_TYPES, TICKET_SYSTEMS, TICKET_PRIORITIES } from './services/intake.js';
import { runRadarScan, startRadarScheduler, radarHealth } from './services/radar/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Caddy — trust one hop so req.ip reflects the real client
app.set('trust proxy', 1);

// Parse JSON and URL-encoded bodies
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CIIIC Event Automator',
    description: 'Routes emails by recipient address',
    endpoints: {
      'POST /webhook/email': 'Unified webhook - routes by recipient address',
      'POST /webhook/test': 'Test with raw content (use "to" field for routing)',
      'POST /draft/save': 'Save a Publieke Waarden Zelftoets draft and email a resume link',
      'GET /draft/:token': 'Resume a saved Publieke Waarden Zelftoets draft',
      'POST /intake/ticket': 'Create a Notion ticket from the chatbot (bearer auth)',
      'GET /health': 'Service health check with API status',
    },
    emailAddresses: {
      'events@bot.ciiic.nl': 'Creates calendar events',
      'nieuwsbriefitem@bot.ciiic.nl': 'Creates newsletter items',
      '*@bot.ciiic.nl': 'Catch-all → creates inbox items',
    },
  });
});

// Health check with API connectivity tests
app.get('/health', async (req, res) => {
  const [notionStatus, brevoStatus, intakeStatus] = await Promise.all([
    testNotion(),
    testBrevo(),
    testIntake(),
  ]);

  const healthy = notionStatus.success && brevoStatus.success;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    services: {
      notion: notionStatus,
      brevo: brevoStatus,
      intake: { ...intakeStatus, configured: !!process.env.INTAKE_TOKEN },
      radar: { ...radarHealth(), configured: !!process.env.RADAR_INGEST_SECRET },
      openai: {
        configured: !!process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-4o',
      },
      drafts: draftsHealth(),
    },
  });
});

// ============================================
// Draft-Resume Endpoints (publicvalues.ciiic.nl)
// ============================================

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_REGEX = /^[A-Za-z0-9_-]{40,50}$/;
const MAX_DATA_BYTES = 256 * 1024;

const draftRouter = express.Router();

draftRouter.use(cors({
  origin: ['https://publicvalues.ciiic.nl', 'http://localhost:4321'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

const draftSaveIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds: 15 * 60 });
  },
});

const draftSaveEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body?.email || '').toLowerCase(),
  skip: (req) => !req.body?.email,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds: 60 * 60 });
  },
});

draftRouter.post('/save', draftSaveIpLimiter, draftSaveEmailLimiter, async (req, res) => {
  const { data, email } = req.body || {};

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ ok: false, error: 'invalid_data' });
  }

  let serialised;
  try {
    serialised = JSON.stringify(data);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_data' });
  }

  if (Buffer.byteLength(serialised, 'utf8') > MAX_DATA_BYTES) {
    return res.status(413).json({ ok: false, error: 'data_too_large' });
  }

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const normalisedEmail = email.toLowerCase();
  const tokenPrefix = (token) => token.slice(0, 6);

  let saved;
  try {
    saved = saveDraft({ data, email: normalisedEmail });
  } catch (error) {
    console.error('❌ Draft save DB error:', error.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }

  try {
    await sendDraftResumeEmail(normalisedEmail, saved.token, saved.expiresAt);
  } catch (error) {
    console.error('❌ Draft email send failed, rolling back row:', error.message);
    try {
      deleteDraft(saved.token);
    } catch (rollbackError) {
      console.error('❌ Draft rollback also failed:', rollbackError.message);
    }
    return res.status(500).json({ ok: false, error: 'email_send_failed' });
  }

  console.log(`💾 Draft saved ip=${req.ip} token=${tokenPrefix(saved.token)}… ok`);
  res.json({ ok: true, expiresAt: saved.expiresAt });
});

draftRouter.get('/:token', (req, res) => {
  const { token } = req.params;

  if (!TOKEN_REGEX.test(token)) {
    return res.status(400).json({ ok: false, error: 'invalid_token' });
  }

  const draft = getDraft(token);
  if (!draft) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  res.json({
    ok: true,
    data: draft.data,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
  });
});

app.use('/draft', draftRouter);

// ============================================
// Intake Ticket Endpoint (chatbot → Notion)
// ============================================
//
// Lets ciiicbot (ai.ciiic.nl) log a user's request as a ticket in the Notion
// database "Website 2026 bugs & doorontwikkeling". Auth is a shared bearer
// secret (INTAKE_TOKEN); the Notion token stays server-side.

/**
 * Constant-time bearer-token check against INTAKE_TOKEN.
 */
function requireIntakeToken(req, res, next) {
  const expected = process.env.INTAKE_TOKEN;
  if (!expected) {
    console.error('❌ INTAKE_TOKEN not configured — /intake/ticket disabled');
    return res.status(503).json({ ok: false, error: 'intake_not_configured' });
  }

  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  next();
}

app.post('/intake/ticket', requireIntakeToken, async (req, res) => {
  const body = req.body || {};
  const issue = typeof body.issue === 'string' ? body.issue.trim() : '';
  const beschrijving = typeof body.beschrijving === 'string' ? body.beschrijving.trim() : '';

  if (!issue) {
    return res.status(400).json({ ok: false, error: 'missing_field', field: 'issue' });
  }
  if (!beschrijving) {
    return res.status(400).json({ ok: false, error: 'missing_field', field: 'beschrijving' });
  }

  // Optional select fields: validate against the allowed sets when provided.
  const type = body.type == null || body.type === '' ? undefined : String(body.type);
  if (type && !TICKET_TYPES.includes(type)) {
    return res.status(400).json({ ok: false, error: 'invalid_value', field: 'type', allowed: TICKET_TYPES });
  }

  const systeem = body.systeem == null || body.systeem === '' ? undefined : String(body.systeem);
  if (systeem && !TICKET_SYSTEMS.includes(systeem)) {
    return res.status(400).json({ ok: false, error: 'invalid_value', field: 'systeem', allowed: TICKET_SYSTEMS });
  }

  const prioriteit = body.prioriteit == null || body.prioriteit === '' ? undefined : String(body.prioriteit);
  if (prioriteit && !TICKET_PRIORITIES.includes(prioriteit)) {
    return res.status(400).json({ ok: false, error: 'invalid_value', field: 'prioriteit', allowed: TICKET_PRIORITIES });
  }

  const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined;

  try {
    const result = await createTicket({
      issue,
      beschrijving,
      type,
      systeem,
      prioriteit,
      url,
      indiener_email: body.indiener_email,
      indiener_naam: body.indiener_naam,
    });

    console.log(`🎫 Intake ticket created: ${result.url} (ingediendDoor resolved=${result.ingediendDoorResolved})`);
    return res.json({
      ok: true,
      success: true,
      notionUrl: result.url,
      ticketId: result.id,
      ingediendDoorResolved: result.ingediendDoorResolved,
    });
  } catch (error) {
    console.error('❌ Intake ticket error:', error.message);
    return res.status(500).json({ ok: false, error: 'internal_error', message: error.message });
  }
});

/**
 * Constant-time bearer-token check against RADAR_INGEST_SECRET (radar admin ops).
 */
function requireRadarToken(req, res, next) {
  const expected = process.env.RADAR_INGEST_SECRET;
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'radar_not_configured' });
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// Manually trigger a radar scan (the scheduler runs it daily). Bearer-gated.
//   ?dryRun=1  extract + dedup but do not POST or advance watermarks
//   ?only=xrmust  restrict to one source
app.post('/radar/scan', requireRadarToken, async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const only = typeof req.query.only === 'string' ? req.query.only : null;
  try {
    const result = await runRadarScan({ dryRun, only });
    return res.json(result);
  } catch (error) {
    console.error('❌ Radar scan error:', error.message);
    return res.status(500).json({ ok: false, error: 'internal_error', message: error.message });
  }
});

/**
 * Main webhook endpoint for all inbound emails
 * Routes based on recipient address:
 * - events@bot.ciiic.nl → Event creation
 * - nieuwsbriefitem@bot.ciiic.nl → Newsletter item creation
 *
 * Supports multiple email service formats:
 * - Brevo Inbound Parsing
 * - SendGrid Inbound Parse
 * - Mailgun
 * - Postmark
 * - Generic JSON format
 */
app.post('/webhook/email', async (req, res) => {
  console.log('📧 Received webhook request');

  try {
    // Extract email content based on the format
    const { from, to, subject, body } = parseInboundEmail(req.body, req.headers);

    if (!body) {
      console.error('No email body found in request');
      return res.status(400).json({ error: 'No email body found' });
    }

    console.log(`📨 Email from: ${from}, to: ${to}, subject: ${subject}`);

    // Route based on recipient address
    const recipient = to.toLowerCase();

    if (recipient.includes('nieuwsbriefitem@')) {
      // Newsletter item flow
      console.log('📰 Routing to newsletter item handler');
      const result = await processNewsletterItem(from, subject, body);

      console.log(`✅ Newsletter item created: ${result.title}`);
      return res.json({
        success: true,
        type: 'newsletter_item',
        title: result.title,
        notionUrl: result.notionUrl,
        weekNumber: result.weekNumber,
        publicatieDatum: result.publicatieDatum,
      });
    } else if (recipient.includes('events@')) {
      // Event flow
      console.log('📅 Routing to event handler');
      const result = await processEmail(from, subject, body);

      console.log(`✅ Event created: ${result.eventName}`);
      return res.json({
        success: true,
        type: 'event',
        event: result.eventName,
        notionUrl: result.notionUrl,
      });
    } else {
      // Catch-all: Inbox flow
      console.log('📥 Routing to inbox handler');
      const result = await processInboxItem(from, subject, body);

      console.log(`✅ Inbox item created: ${result.name}`);
      return res.json({
        success: true,
        type: 'inbox',
        name: result.name,
        notionUrl: result.notionUrl,
      });
    }
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Test endpoint - accepts raw email content
 * Use 'to' field to specify routing:
 * - to: 'nieuwsbriefitem@bot.ciiic.nl' → Newsletter item
 * - to: 'events@bot.ciiic.nl' (or omit) → Event
 */
app.post('/webhook/test', async (req, res) => {
  const { from, to, subject, body, email } = req.body;

  // Allow either structured or just raw email content
  const emailContent = body || email || req.body.content;
  const senderEmail = from || 'test@example.com';
  const recipient = (to || '').toLowerCase();

  if (!emailContent) {
    return res.status(400).json({
      error: 'Please provide email content in body, email, or content field',
    });
  }

  try {
    if (recipient.includes('nieuwsbriefitem@')) {
      // Newsletter item flow
      const result = await processNewsletterItem(senderEmail, subject, emailContent);
      res.json({
        success: true,
        type: 'newsletter_item',
        title: result.title,
        notionUrl: result.notionUrl,
        weekNumber: result.weekNumber,
        publicatieDatum: result.publicatieDatum,
        parsedData: result.parsedData,
      });
    } else if (recipient.includes('events@')) {
      // Event flow
      const result = await processEmail(senderEmail, subject, emailContent);
      res.json({
        success: true,
        type: 'event',
        event: result.eventName,
        notionUrl: result.notionUrl,
        parsedData: result.parsedData,
      });
    } else {
      // Inbox flow (catch-all, also default for test without 'to')
      const result = await processInboxItem(senderEmail, subject, emailContent);
      res.json({
        success: true,
        type: 'inbox',
        name: result.name,
        notionUrl: result.notionUrl,
        parsedData: result.parsedData,
      });
    }
  } catch (error) {
    console.error('Test error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Parse inbound email from various service formats
 * Returns: { from, to, subject, body }
 */
function parseInboundEmail(body, headers) {
  // Log incoming format for debugging
  console.log('📬 Parsing email, keys:', Object.keys(body).join(', '));

  // Brevo wraps emails in an "items" array - unwrap it
  if (body.items && Array.isArray(body.items) && body.items.length > 0) {
    console.log('📬 Brevo items wrapper detected, unwrapping...');
    body = body.items[0];
    console.log('📬 Unwrapped keys:', Object.keys(body).join(', '));
  }

  // Brevo Inbound Parsing format
  if (body.Uuid || body.MessageId || (body.From && body.RawHtmlBody)) {
    const from = body.From?.Address || (typeof body.From === 'string' ? extractEmail(body.From) : '') || extractEmail(body.ReplyTo || '');
    // Extract To - Brevo sends it in various formats
    let to = '';
    if (Array.isArray(body.To) && body.To.length > 0) {
      to = body.To[0]?.Address || body.To[0] || '';
    } else if (typeof body.To === 'string') {
      to = body.To;
    } else if (body.To?.Address) {
      to = body.To.Address;
    }
    to = extractEmail(to);
    console.log('📬 Brevo format detected, From:', body.From, '→', from, ', To:', body.To, '→', to);
    return {
      from,
      to,
      subject: body.Subject || '',
      body: body.RawTextBody || body.ExtractedMarkdownMessage || stripHtml(body.RawHtmlBody),
    };
  }

  // SendGrid Inbound Parse format
  if (body.from && (body.text || body.html)) {
    return {
      from: extractEmail(body.from),
      to: extractEmail(body.to || body.envelope?.to?.[0] || ''),
      subject: body.subject || '',
      body: body.text || stripHtml(body.html),
    };
  }

  // Mailgun format
  if (body.sender && (body['body-plain'] || body['body-html'])) {
    return {
      from: body.sender,
      to: body.recipient || '',
      subject: body.subject || '',
      body: body['body-plain'] || stripHtml(body['body-html']),
    };
  }

  // Postmark format
  if (body.FromFull || body.From) {
    return {
      from: body.FromFull?.Email || body.From,
      to: body.ToFull?.[0]?.Email || body.To || '',
      subject: body.Subject || '',
      body: body.TextBody || stripHtml(body.HtmlBody),
    };
  }

  // Generic JSON format
  if (body.from || body.sender) {
    return {
      from: body.from || body.sender,
      to: body.to || body.recipient || '',
      subject: body.subject || '',
      body: body.body || body.text || body.content || body.html,
    };
  }

  // Fallback: try to find anything useful
  console.log('📬 No format matched, using fallback. Body sample:', JSON.stringify(body).substring(0, 500));
  return {
    from: body.email || body.from_email || 'unknown',
    to: body.to || body.recipient || '',
    subject: body.subject || '',
    body: body.body || body.text || body.content || body.message || JSON.stringify(body),
  };
}

/**
 * Extract email address from "Name <email@example.com>" format
 */
function extractEmail(fromField) {
  if (!fromField) return '';
  const match = fromField.match(/<([^>]+)>/);
  return match ? match[1] : fromField;
}

/**
 * Get a friendly display name from an email address
 * - For @ciiic.nl: returns first name (capitalized)
 * - For others: returns the part before @ (capitalized)
 */
function getFriendlyName(email) {
  if (!email || email === 'unknown') return 'Iemand';

  const emailLower = email.toLowerCase();
  const localPart = emailLower.split('@')[0];

  // Capitalize first letter
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // For @ciiic.nl addresses, assume format is firstname@ciiic.nl
  if (emailLower.includes('@ciiic.nl')) {
    return capitalize(localPart);
  }

  // For other addresses, try to make it readable
  // Replace dots/underscores with spaces and capitalize
  const name = localPart.replace(/[._]/g, ' ').split(' ')[0];
  return capitalize(name);
}

/**
 * Strip HTML tags (basic)
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Main processing function
 */
async function processEmail(from, subject, body) {
  // Combine subject and body for better context
  const fullContent = subject
    ? `Subject: ${subject}\n\n${body}`
    : body;

  console.log('🤖 Parsing email with OpenAI...');

  // Parse event data with OpenAI
  const eventData = await parseEventFromEmail(fullContent, from);

  console.log('📝 Parsed event data:', JSON.stringify(eventData, null, 2));

  // Validate required fields
  if (!eventData.eventName || !eventData.eventDate) {
    const error = 'Could not extract event name or date from email';
    if (from && from !== 'unknown') {
      await sendErrorNotification(from, error).catch(e => console.error('Failed to send error email:', e));
    }
    throw new Error(error);
  }

  console.log('📅 Creating Notion event...');

  // Create event in Notion
  const notionPage = await createEvent(eventData);

  console.log(`✨ Created Notion page: ${notionPage.url}`);

  // Build meta description and send Zapier notification (Dutch)
  // Use LLM-extracted name, fallback to email parsing
  const senderName = eventData.senderName || getFriendlyName(from);
  const eventDescription = `${senderName} heeft een event ingediend: ${eventData.eventName}${eventData.eventDate ? ` op ${eventData.eventDate}` : ''}`;
  await sendZapierNotification('event', eventData.eventName, eventDescription, notionPage.url);

  // Send confirmation email
  if (from && from !== 'unknown' && from !== 'test@example.com') {
    console.log('📤 Sending confirmation email...');
    try {
      await sendEventConfirmation(from, eventData.eventName, notionPage.url);
      console.log('📬 Confirmation email sent');
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
      // Don't throw - the event was created successfully
    }
  }

  return {
    eventName: eventData.eventName,
    notionUrl: notionPage.url,
    parsedData: eventData,
  };
}

/**
 * Build a meta description of the newsletter item creation process (Dutch)
 * Uses LLM-extracted names for accuracy
 */
function buildMetaDescription(from, parsedData) {
  // Use LLM-extracted names, fallback to email parsing
  const forwarder = parsedData.forwarderName || getFriendlyName(from);
  const originalSender = parsedData.originalSenderName;
  const topic = parsedData.topicSummary || parsedData.title || 'een nieuwsbrief item';

  if (originalSender) {
    return `${forwarder} heeft een tip doorgestuurd van ${originalSender} over ${topic}`;
  } else {
    return `${forwarder} heeft een nieuwsbrief item ingediend over ${topic}`;
  }
}

/**
 * Send webhook notification to Zapier
 * @param {string} type - 'event' or 'newsletter-item'
 * @param {string} title - Item title
 * @param {string} description - Meta description of the creation process
 * @param {string} notionUrl - URL to the created Notion page
 */
async function sendZapierNotification(type, title, description, notionUrl) {
  const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;

  if (!ZAPIER_WEBHOOK_URL) {
    console.log('⚠️ ZAPIER_WEBHOOK_URL not configured, skipping notification');
    return;
  }

  try {
    const response = await fetch(ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type,
        title,
        description,
        notionUrl,
      }),
    });

    if (!response.ok) {
      console.error(`Zapier webhook failed (${response.status}): ${await response.text()}`);
    } else {
      console.log(`🔔 Zapier notification sent (${type})`);
    }
  } catch (error) {
    console.error('Failed to send Zapier notification:', error.message);
    // Don't throw - notification is not critical
  }
}

/**
 * Process newsletter item from email
 */
async function processNewsletterItem(from, subject, body) {
  // Combine subject and body for better context
  const fullContent = subject
    ? `Subject: ${subject}\n\n${body}`
    : body;

  // Try to fetch content from URLs in the email for better context
  let urlContent = null;
  const urls = extractUrls(body || '');
  if (urls.length > 0) {
    console.log(`🔗 Found ${urls.length} URL(s), fetching first one: ${urls[0]}`);
    urlContent = await fetchUrlContent(urls[0]);
  }

  console.log('🤖 Parsing newsletter item with OpenAI...');

  // Parse content with OpenAI, including URL content if available
  const parsedData = await parseNewsletterItemFromEmail(fullContent, from, urlContent);

  console.log('📝 Parsed newsletter item data:', JSON.stringify(parsedData, null, 2));

  // Use subject as fallback title if not extracted
  const title = parsedData.title || subject || 'Nieuwsbrief item';

  console.log('📅 Creating Notion content item...');

  // Create content item in Notion
  const notionPage = await createContentItem({
    title,
    beschrijving: parsedData.beschrijving,
    url: parsedData.url,
  });

  console.log(`✨ Created Notion page: ${notionPage.url}`);

  // Add a comment with context about the submission
  const commentText = `📧 Toegevoegd via e-mail
Afzender: ${from}
Onderwerp: ${subject || '(geen onderwerp)'}
Datum: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}
${parsedData.originalSender ? `Originele afzender: ${parsedData.originalSender}` : ''}
${parsedData.url ? `URL: ${parsedData.url}` : ''}`.trim();

  await addComment(notionPage.id, commentText);

  // Build meta description and send Zapier notification
  const metaDescription = buildMetaDescription(from, parsedData);
  await sendZapierNotification('newsletter-item', title, metaDescription, notionPage.url);

  // Send confirmation email
  if (from && from !== 'unknown' && from !== 'test@example.com') {
    console.log('📤 Sending confirmation email...');
    try {
      await sendNewsletterItemConfirmation(
        from,
        title,
        notionPage.url,
        notionPage.weekNumber,
        notionPage.publicatieDatum
      );
      console.log('📬 Confirmation email sent');
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
      // Don't throw - the item was created successfully
    }
  }

  return {
    title,
    notionUrl: notionPage.url,
    weekNumber: notionPage.weekNumber,
    publicatieDatum: notionPage.publicatieDatum,
    linkedNewsletter: notionPage.linkedNewsletter,
    parsedData,
  };
}

/**
 * Process inbox item from email (catch-all)
 */
async function processInboxItem(from, subject, body) {
  const fullContent = subject
    ? `Subject: ${subject}\n\n${body}`
    : body;

  console.log('🤖 Parsing inbox item with OpenAI...');

  const parsedData = await parseInboxItemFromEmail(fullContent, from);

  console.log('📝 Parsed inbox item data:', JSON.stringify(parsedData, null, 2));

  const name = parsedData.name || subject || 'Inbox item';

  console.log('📥 Creating Notion inbox item...');

  const notionPage = await createInboxItem({
    name,
    description: parsedData.description,
    url: parsedData.url,
  });

  console.log(`✨ Created Notion page: ${notionPage.url}`);

  // Add a comment with context
  const commentText = `📧 Ontvangen via e-mail
Afzender: ${from}
Onderwerp: ${subject || '(geen onderwerp)'}
Datum: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}
${parsedData.url ? `URL: ${parsedData.url}` : ''}`.trim();

  await addComment(notionPage.id, commentText);

  // Send Zapier notification (Dutch)
  // Use LLM-extracted name, fallback to email parsing
  const senderName = parsedData.senderName || getFriendlyName(from);
  const inboxDescription = `${senderName} heeft een e-mail gestuurd: ${parsedData.description || subject || 'geen beschrijving'}`;
  await sendZapierNotification('inbox', name, inboxDescription, notionPage.url);

  return {
    name,
    notionUrl: notionPage.url,
    parsedData,
  };
}

// ==========================================
// Jaarevent 2026 Registration Sync Endpoints
// ==========================================

/**
 * New registration webhook from Gravity Forms
 * Configure in GF → Settings → Webhooks → Request URL: https://bot.ciiic.nl/webhook/registration
 */
app.post('/webhook/registration', async (req, res) => {
  console.log('📝 Received registration webhook');
  try {
    const result = await processRegistration(req.body);
    console.log('✅ Registration processed:', JSON.stringify(result));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Registration error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * Registration status change webhook from GF mu-plugin
 * Triggered when cancel link is clicked (status → cancelled)
 */
app.post('/webhook/registration-status', async (req, res) => {
  console.log('🔄 Received registration status change');

  // Verify signature if configured
  const signature = req.headers['x-webhook-signature'];
  if (process.env.JAAREVENT_WEBHOOK_SECRET && !verifySignature(JSON.stringify(req.body), signature)) {
    console.error('❌ Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const result = await processStatusChange(req.body);
    console.log('✅ Status change processed:', JSON.stringify(result));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Status change error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * SXSW London 2026 newsletter opt-in webhook (Forms 26 + 27)
 * Subscribes opted-in registrants to the main CIIIC Mailchimp list.
 */
app.post('/webhook/sxsw-newsletter', async (req, res) => {
  console.log('📝 Received SXSW webhook');
  try {
    const result = await processSxswSubmission(req.body);
    console.log('✅ SXSW processed:', JSON.stringify(result));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ SXSW error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * Check-in scan webhook (day of event)
 */
app.post('/webhook/checkin', async (req, res) => {
  console.log('📱 Received check-in webhook');
  try {
    const result = await processCheckin(req.body);
    console.log('✅ Check-in processed:', JSON.stringify(result));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Check-in error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Initialise drafts store + schedule purge
try {
  const { dbPath } = initDraftsDb();
  const removed = purgeExpired();
  console.log(`💾 Drafts DB ready at ${dbPath} (purged ${removed} expired on boot)`);
  setInterval(() => {
    try {
      const n = purgeExpired();
      if (n > 0) console.log(`🧹 Purged ${n} expired drafts`);
    } catch (error) {
      console.error('❌ Drafts purge failed:', error.message);
    }
  }, 6 * 60 * 60 * 1000);
} catch (error) {
  console.error('❌ Failed to initialise drafts DB:', error.message);
}

// Radar signals — daily scan of the source allowlist → monitor ingest endpoint.
if (process.env.RADAR_INGEST_SECRET) {
  try {
    startRadarScheduler();
  } catch (error) {
    console.error('❌ Failed to start radar scheduler:', error.message);
  }
} else {
  console.log('📡 Radar scheduler disabled (RADAR_INGEST_SECRET not set)');
}

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 CIIIC Event Automator running on port ${PORT}

Endpoints:
  GET  /              - Service info
  GET  /health        - Health check with API status
  POST /webhook/email - Unified webhook (routes by recipient address)
  POST /webhook/test  - Test with raw content
  POST /draft/save    - Save a self-assessment draft (emails a resume link)
  GET  /draft/:token  - Resume a saved draft
  POST /intake/ticket - Create a Notion ticket from the chatbot (bearer auth)
  POST /radar/scan    - Trigger a radar source scan → monitor ingest (bearer auth)

Email routing (all send Zapier notifications):
  events@bot.ciiic.nl          → Calendar events (type: event)
  nieuwsbriefitem@bot.ciiic.nl → Newsletter items (type: newsletter-item)
  *@bot.ciiic.nl               → Inbox catch-all (type: inbox)

Configure your email service to POST all *@bot.ciiic.nl to:
  https://bot.ciiic.nl/webhook/email
`);
});
