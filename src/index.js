import 'dotenv/config';
import express from 'express';
import { parseEventFromEmail } from './services/openai.js';
import { createEvent, testConnection as testNotion } from './services/notion.js';
import { sendEventConfirmation, sendErrorNotification, testConnection as testBrevo } from './services/brevo.js';

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
    endpoints: {
      'POST /webhook/email': 'Receive inbound emails (supports SendGrid, Mailgun, Postmark formats)',
      'POST /webhook/test': 'Test with raw email content',
      'GET /health': 'Service health check with API status',
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
 * Main webhook endpoint for inbound emails
 * Supports multiple email service formats:
 * - SendGrid Inbound Parse
 * - Mailgun
 * - Postmark
 * - Generic JSON format
 */
app.post('/webhook/email', async (req, res) => {
  console.log('📧 Received webhook request');

  try {
    // Extract email content based on the format
    const { from, subject, body } = parseInboundEmail(req.body, req.headers);

    if (!body) {
      console.error('No email body found in request');
      return res.status(400).json({ error: 'No email body found' });
    }

    console.log(`📨 Processing email from: ${from}, subject: ${subject}`);

    // Process the email
    const result = await processEmail(from, subject, body);

    console.log(`✅ Event created: ${result.eventName}`);
    res.json({
      success: true,
      event: result.eventName,
      notionUrl: result.notionUrl,
    });
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
 */
app.post('/webhook/test', async (req, res) => {
  const { from, subject, body, email } = req.body;

  // Allow either structured or just raw email content
  const emailContent = body || email || req.body.content;
  const senderEmail = from || 'test@example.com';

  if (!emailContent) {
    return res.status(400).json({
      error: 'Please provide email content in body, email, or content field',
    });
  }

  try {
    const result = await processEmail(senderEmail, subject, emailContent);
    res.json({
      success: true,
      event: result.eventName,
      notionUrl: result.notionUrl,
      parsedData: result.parsedData,
    });
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
 */
function parseInboundEmail(body, headers) {
  // Brevo Inbound Parsing format
  if (body.Uuid || body.MessageId || (body.From && body.RawHtmlBody)) {
    return {
      from: body.From?.Address || body.From || extractEmail(body.ReplyTo || ''),
      subject: body.Subject || '',
      body: body.RawTextBody || body.ExtractedMarkdownMessage || stripHtml(body.RawHtmlBody),
    };
  }

  // SendGrid Inbound Parse format
  if (body.from && (body.text || body.html)) {
    return {
      from: extractEmail(body.from),
      subject: body.subject || '',
      body: body.text || stripHtml(body.html),
    };
  }

  // Mailgun format
  if (body.sender && (body['body-plain'] || body['body-html'])) {
    return {
      from: body.sender,
      subject: body.subject || '',
      body: body['body-plain'] || stripHtml(body['body-html']),
    };
  }

  // Postmark format
  if (body.FromFull || body.From) {
    return {
      from: body.FromFull?.Email || body.From,
      subject: body.Subject || '',
      body: body.TextBody || stripHtml(body.HtmlBody),
    };
  }

  // Generic JSON format
  if (body.from || body.sender) {
    return {
      from: body.from || body.sender,
      subject: body.subject || '',
      body: body.body || body.text || body.content || body.html,
    };
  }

  // Fallback: try to find anything useful
  return {
    from: body.email || body.from_email || 'unknown',
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

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 CIIIC Event Automator running on port ${PORT}

Endpoints:
  GET  /         - Service info
  GET  /health   - Health check with API status
  POST /webhook/email - Inbound email webhook
  POST /webhook/test  - Test with raw content

Configure your email service to POST to:
  https://your-domain.com/webhook/email
`);
});
