import 'dotenv/config';
import express from 'express';
import { parseEventFromEmail, parseNewsletterItemFromEmail } from './services/openai.js';
import { createEvent, createContentItem, addComment, getNextThursday, getWeekNumber, testConnection as testNotion } from './services/notion.js';
import { sendEventConfirmation, sendNewsletterItemConfirmation, sendErrorNotification, sendEmail, testConnection as testBrevo } from './services/brevo.js';

const app = express();
const PORT = process.env.PORT || 3000;

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
      'POST /webhook/email': 'Unified webhook - routes by recipient (events@ or nieuwsbriefitem@)',
      'POST /webhook/test': 'Test with raw content (use "to" field for routing)',
      'GET /health': 'Service health check with API status',
    },
    emailAddresses: {
      'events@bot.ciiic.nl': 'Creates calendar events in Notion',
      'nieuwsbriefitem@bot.ciiic.nl': 'Creates newsletter items in content database',
    },
  });
});

// Health check with API connectivity tests
app.get('/health', async (req, res) => {
  const [notionStatus, brevoStatus] = await Promise.all([
    testNotion(),
    testBrevo(),
  ]);

  const healthy = notionStatus.success && brevoStatus.success;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    services: {
      notion: notionStatus,
      brevo: brevoStatus,
      openai: {
        configured: !!process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-4o',
      },
    },
  });
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
    } else {
      // Default: Event flow (events@bot.ciiic.nl or any other address)
      console.log('📅 Routing to event handler');
      const result = await processEmail(from, subject, body);

      console.log(`✅ Event created: ${result.eventName}`);
      return res.json({
        success: true,
        type: 'event',
        event: result.eventName,
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
    } else {
      // Event flow (default)
      const result = await processEmail(senderEmail, subject, emailContent);
      res.json({
        success: true,
        type: 'event',
        event: result.eventName,
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
  // Brevo Inbound Parsing format
  if (body.Uuid || body.MessageId || (body.From && body.RawHtmlBody)) {
    return {
      from: body.From?.Address || body.From || extractEmail(body.ReplyTo || ''),
      to: extractEmail(body.To?.[0]?.Address || body.To?.[0] || body.To || ''),
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
  const match = fromField.match(/<([^>]+)>/);
  return match ? match[1] : fromField;
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

  // Build meta description and send Zapier notification
  const forwarder = from.split('@')[0];
  const eventDescription = `${forwarder} submitted an event: ${eventData.eventName}${eventData.eventDate ? ` on ${eventData.eventDate}` : ''}`;
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
 * Build a meta description of the newsletter item creation process
 */
function buildMetaDescription(from, parsedData) {
  const forwarder = from.split('@')[0]; // Get name/username part of email
  const originalSender = parsedData.originalSender;
  const topic = parsedData.topicSummary || parsedData.title || 'een nieuwsbrief item';

  if (originalSender) {
    return `${forwarder} forwarded a tip from ${originalSender} about ${topic}`;
  } else {
    return `${forwarder} submitted a newsletter item about ${topic}`;
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
  const ZAPIER_WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/23306921/uq2svjo/';

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

  console.log('🤖 Parsing newsletter item with OpenAI...');

  // Parse content with OpenAI
  const parsedData = await parseNewsletterItemFromEmail(fullContent, from);

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

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 CIIIC Event Automator running on port ${PORT}

Endpoints:
  GET  /              - Service info
  GET  /health        - Health check with API status
  POST /webhook/email - Unified webhook (routes by recipient address)
  POST /webhook/test  - Test with raw content

Email addresses (all route to /webhook/email):
  events@bot.ciiic.nl          → Creates calendar events
  nieuwsbriefitem@bot.ciiic.nl → Creates newsletter items + notifies Zapier

Configure your email service to POST all *@bot.ciiic.nl to:
  https://bot.ciiic.nl/webhook/email
`);
});
