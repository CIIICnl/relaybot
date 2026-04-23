import 'dotenv/config';
import express from 'express';
import { parseEventFromEmail, parseNewsletterItemFromEmail, parseInboxItemFromEmail, extractUrls, fetchUrlContent, detectContentType, parseEventFromSlackMessage, parseNewsletterItemFromSlackMessage } from './services/openai.js';
import { createEvent, createContentItem, createInboxItem, addComment, testConnection as testNotion, getWeekNumber, getNextThursday } from './services/notion.js';
import { sendEventConfirmation, sendNewsletterItemConfirmation, sendErrorNotification, testConnection as testBrevo } from './services/brevo.js';
import { processRegistration, processStatusChange, processCheckin, verifySignature } from './services/jaarevent.js';
import * as slack from './services/slack.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON and URL-encoded bodies
// For Slack signature verification, we need to capture the raw body
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CIIIC Relaybot',
    description: 'Routes emails and Slack messages to Notion',
    endpoints: {
      'POST /webhook/email': 'Email webhook - routes by recipient address',
      'POST /webhook/slack/events': 'Slack events (reactions, mentions)',
      'POST /webhook/slack/interactions': 'Slack interactions (modals, buttons, shortcuts)',
      'POST /webhook/test': 'Test with raw content (use "to" field for routing)',
      'GET /health': 'Service health check with API status',
    },
    emailAddresses: {
      'events@bot.ciiic.nl': 'Creates calendar events',
      'nieuwsbriefitem@bot.ciiic.nl': 'Creates newsletter items',
      '*@bot.ciiic.nl': 'Catch-all → creates inbox items',
    },
    slack: {
      'emoji reaction': 'React with 📌 to add message to Notion (AI auto-detects type)',
      'message shortcut': 'Right-click → "Add to Notion" for manual type selection',
    },
  });
});

// Health check with API connectivity tests
app.get('/health', async (req, res) => {
  const [notionStatus, brevoStatus, slackStatus] = await Promise.all([
    testNotion(),
    testBrevo(),
    slack.testConnection(),
  ]);

  const healthy = notionStatus.success && brevoStatus.success;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    services: {
      notion: notionStatus,
      brevo: brevoStatus,
      slack: slackStatus,
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

// ============================================
// Slack Webhook Endpoints
// ============================================

// Track processed events to avoid duplicates (Slack retries)
const processedEvents = new Set();

/**
 * Slack Events API endpoint
 * Handles: URL verification, reaction_added events
 */
app.post('/webhook/slack/events', async (req, res) => {
  // Handle URL verification challenge (required for Slack app setup)
  if (req.body.type === 'url_verification') {
    console.log('🔗 Slack URL verification');
    return res.json({ challenge: req.body.challenge });
  }

  // Verify signature (skip in development if needed)
  if (process.env.SLACK_SIGNING_SECRET && !slack.verifySlackSignature(req)) {
    console.error('❌ Invalid Slack signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Acknowledge immediately (Slack requires response within 3 seconds)
  res.status(200).send();

  const event = req.body.event;
  if (!event) return;

  // Deduplicate events (Slack may retry)
  const eventId = req.body.event_id;
  if (processedEvents.has(eventId)) {
    console.log(`⏭️ Skipping duplicate event: ${eventId}`);
    return;
  }
  processedEvents.add(eventId);
  // Clean up old events after 5 minutes
  setTimeout(() => processedEvents.delete(eventId), 5 * 60 * 1000);

  console.log(`📨 Slack event: ${event.type}`);

  try {
    // Handle 📌 emoji reaction
    if (event.type === 'reaction_added' && event.reaction === 'pushpin') {
      await handlePushpinReaction(event);
    }
  } catch (error) {
    console.error('❌ Error handling Slack event:', error);
  }
});

/**
 * Slack Interactions endpoint
 * Handles: message shortcuts, modal submissions, button clicks
 */
app.post('/webhook/slack/interactions', async (req, res) => {
  // Interactions come as URL-encoded payload
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Verify signature
  if (process.env.SLACK_SIGNING_SECRET && !slack.verifySlackSignature(req)) {
    console.error('❌ Invalid Slack signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log(`🎯 Slack interaction: ${payload.type}`);

  try {
    // Handle message shortcut (right-click → "Add to Notion")
    if (payload.type === 'message_action' && payload.callback_id === 'add_to_notion') {
      await handleMessageShortcut(payload, res);
      return;
    }

    // Handle modal submission
    if (payload.type === 'view_submission' && payload.view.callback_id === 'add_to_notion_modal') {
      await handleModalSubmission(payload, res);
      return;
    }

    // Handle button clicks (type selection)
    if (payload.type === 'block_actions') {
      await handleButtonClick(payload, res);
      return;
    }

    res.status(200).send();
  } catch (error) {
    console.error('❌ Error handling Slack interaction:', error);
    res.status(200).send(); // Always respond 200 to Slack
  }
});

/**
 * Handle 📌 pushpin reaction - auto-detect and create item
 */
async function handlePushpinReaction(event) {
  const { item, user } = event;

  // Only handle message reactions
  if (item.type !== 'message') return;

  console.log(`📌 Pushpin reaction in channel ${item.channel}`);

  try {
    // Get the message content
    const message = await slack.getMessage(item.channel, item.ts);
    if (!message) {
      console.error('Could not fetch message');
      return;
    }

    // Get user info for the confirmation
    const userInfo = await slack.getUserInfo(user);
    const userName = userInfo?.real_name || userInfo?.name || 'Someone';

    // Add processing reaction
    await slack.addReaction(item.channel, item.ts, 'hourglass_flowing_sand');

    // Extract URLs and fetch content if available
    const urls = extractUrls(message.text || '');
    let urlContent = null;
    if (urls.length > 0) {
      console.log(`🔗 Fetching URL: ${urls[0]}`);
      urlContent = await fetchUrlContent(urls[0]);
    }

    // Detect content type
    const detection = await detectContentType(message.text || '', urlContent);
    console.log(`🤖 Detected type: ${detection.type} (confidence: ${detection.confidence})`);

    // If uncertain, ask the user
    if (detection.type === 'uncertain') {
      await slack.postMessage(item.channel, {
        thread_ts: item.ts,
        blocks: slack.buildTypeSelectionMessage(item.ts, item.channel),
      });
      return;
    }

    // Process based on detected type
    const result = await processSlackMessage(
      message.text,
      detection.type === 'event' ? 'event' : 'newsletter',
      userName,
      urlContent
    );

    // Remove hourglass, add checkmark
    await slack.addReaction(item.channel, item.ts, 'white_check_mark');

    // Post confirmation in thread
    await slack.postMessage(item.channel, {
      thread_ts: item.ts,
      blocks: slack.buildSuccessMessage({
        type: result.type,
        title: result.title,
        notionUrl: result.notionUrl,
        details: result.details,
      }),
    });

  } catch (error) {
    console.error('Error processing pushpin reaction:', error);

    // Post error in thread
    await slack.postMessage(item.channel, {
      thread_ts: item.ts,
      blocks: slack.buildErrorMessage(error.message),
    });
  }
}

/**
 * Handle message shortcut (right-click → "Add to Notion")
 */
async function handleMessageShortcut(payload, res) {
  const message = payload.message;
  const channel = payload.channel.id;
  const triggerId = payload.trigger_id;

  // Extract URL from message
  const urls = extractUrls(message.text || '');
  const detectedUrl = urls[0] || null;

  // Try to auto-detect type for the dropdown default
  let suggestedType = 'auto';
  if (detectedUrl) {
    const urlContent = await fetchUrlContent(detectedUrl);
    const detection = await detectContentType(message.text || '', urlContent);
    if (detection.confidence >= 0.7) {
      suggestedType = detection.type === 'event' ? 'event' : 'newsletter';
    }
  }

  // Open modal
  await slack.openModal(triggerId, slack.buildAddToNotionModal({
    messageText: message.text,
    detectedUrl,
    suggestedType,
    channel,
    messageTs: message.ts,
  }));

  res.status(200).send();
}

/**
 * Handle modal submission
 */
async function handleModalSubmission(payload, res) {
  // Acknowledge immediately
  res.status(200).send();

  const values = payload.view.state.values;
  const metadata = JSON.parse(payload.view.private_metadata);
  const selectedType = values.content_type.content_type_select.selected_option.value;

  const { channel, messageTs } = metadata;

  try {
    // Get the original message
    const message = await slack.getMessage(channel, messageTs);
    if (!message) {
      throw new Error('Could not fetch original message');
    }

    // Get user info
    const userInfo = await slack.getUserInfo(payload.user.id);
    const userName = userInfo?.real_name || userInfo?.name || 'Someone';

    // Fetch URL content if available
    const urls = extractUrls(message.text || '');
    let urlContent = null;
    if (urls.length > 0) {
      urlContent = await fetchUrlContent(urls[0]);
    }

    // Determine type
    let type = selectedType;
    if (type === 'auto') {
      const detection = await detectContentType(message.text || '', urlContent);
      type = detection.type === 'event' ? 'event' : 'newsletter';
    }

    // Process the message
    const result = await processSlackMessage(
      message.text,
      type,
      userName,
      urlContent
    );

    // Add checkmark reaction to original message
    await slack.addReaction(channel, messageTs, 'white_check_mark');

    // Post confirmation in thread
    await slack.postMessage(channel, {
      thread_ts: messageTs,
      blocks: slack.buildSuccessMessage({
        type: result.type,
        title: result.title,
        notionUrl: result.notionUrl,
        details: result.details,
      }),
    });

  } catch (error) {
    console.error('Error processing modal submission:', error);

    await slack.postMessage(channel, {
      thread_ts: messageTs,
      blocks: slack.buildErrorMessage(error.message),
    });
  }
}

/**
 * Handle button clicks (type selection when AI is uncertain)
 */
async function handleButtonClick(payload, res) {
  res.status(200).send();

  const action = payload.actions[0];

  // Handle cancel
  if (action.action_id === 'select_type_cancel') {
    // Delete the selection message
    await slack.updateMessage(payload.channel.id, payload.message.ts, {
      text: '❌ Cancelled',
      blocks: [],
    });
    return;
  }

  // Handle type selection
  if (action.action_id === 'select_type_event' || action.action_id === 'select_type_newsletter') {
    const data = JSON.parse(action.value);
    const { type, channel, messageTs } = data;

    // Update the selection message to show processing
    await slack.updateMessage(payload.channel.id, payload.message.ts, {
      blocks: slack.buildProcessingMessage(),
    });

    try {
      // Get the original message
      const message = await slack.getMessage(channel, messageTs);
      if (!message) {
        throw new Error('Could not fetch original message');
      }

      // Get user info
      const userInfo = await slack.getUserInfo(payload.user.id);
      const userName = userInfo?.real_name || userInfo?.name || 'Someone';

      // Fetch URL content
      const urls = extractUrls(message.text || '');
      let urlContent = null;
      if (urls.length > 0) {
        urlContent = await fetchUrlContent(urls[0]);
      }

      // Process the message
      const result = await processSlackMessage(
        message.text,
        type,
        userName,
        urlContent
      );

      // Add checkmark to original message
      await slack.addReaction(channel, messageTs, 'white_check_mark');

      // Update selection message with success
      await slack.updateMessage(payload.channel.id, payload.message.ts, {
        blocks: slack.buildSuccessMessage({
          type: result.type,
          title: result.title,
          notionUrl: result.notionUrl,
          details: result.details,
        }),
      });

    } catch (error) {
      console.error('Error processing type selection:', error);

      await slack.updateMessage(payload.channel.id, payload.message.ts, {
        blocks: slack.buildErrorMessage(error.message),
      });
    }
  }
}

/**
 * Process a Slack message and create a Notion item
 * @param {string} messageText - The message text
 * @param {string} type - 'event' or 'newsletter'
 * @param {string} senderName - Name of the person who shared this
 * @param {string|null} urlContent - Optional fetched URL content
 * @returns {Object} - { type, title, notionUrl, details }
 */
async function processSlackMessage(messageText, type, senderName, urlContent = null) {
  if (type === 'event') {
    // Parse as event
    const eventData = await parseEventFromSlackMessage(messageText, senderName, urlContent);

    if (!eventData.eventName || !eventData.eventDate) {
      throw new Error('Could not extract event name or date from message');
    }

    // Create in Notion
    const notionPage = await createEvent({
      ...eventData,
      senderName,
    });

    // Add comment with Slack context
    const commentText = `📱 Added via Slack by ${senderName}
Date: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}
${eventData.eventUrl ? `URL: ${eventData.eventUrl}` : ''}`.trim();

    await addComment(notionPage.id, commentText);

    // Send Zapier notification
    const description = `${senderName} heeft een event gedeeld via Slack: ${eventData.eventName}${eventData.eventDate ? ` op ${eventData.eventDate}` : ''}`;
    await sendZapierNotification('event', eventData.eventName, description, notionPage.url);

    return {
      type: 'event',
      title: eventData.eventName,
      notionUrl: notionPage.url,
      details: {
        eventDate: eventData.eventDate,
        venue: eventData.venue,
      },
    };
  } else {
    // Parse as newsletter item
    const parsedData = await parseNewsletterItemFromSlackMessage(messageText, senderName, urlContent);

    const title = parsedData.title || 'Nieuwsbrief item';

    // Create in Notion
    const notionPage = await createContentItem({
      title,
      beschrijving: parsedData.beschrijving,
      url: parsedData.url,
    });

    // Add comment with Slack context
    const commentText = `📱 Added via Slack by ${senderName}
Date: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}
${parsedData.url ? `URL: ${parsedData.url}` : ''}`.trim();

    await addComment(notionPage.id, commentText);

    // Send Zapier notification
    const description = `${senderName} heeft een nieuwsbrief item gedeeld via Slack: ${title}`;
    await sendZapierNotification('newsletter-item', title, description, notionPage.url);

    return {
      type: 'newsletter',
      title,
      notionUrl: notionPage.url,
      details: {
        weekNumber: notionPage.weekNumber,
      },
    };
  }
}

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

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 CIIIC Relaybot running on port ${PORT}

Endpoints:
  GET  /                         - Service info
  GET  /health                   - Health check with API status
  POST /webhook/email            - Email webhook (routes by recipient address)
  POST /webhook/slack/events     - Slack events (reactions)
  POST /webhook/slack/interactions - Slack interactions (shortcuts, modals)
  POST /webhook/test             - Test with raw content

Email routing (all send Zapier notifications):
  events@bot.ciiic.nl          → Calendar events (type: event)
  nieuwsbriefitem@bot.ciiic.nl → Newsletter items (type: newsletter-item)
  *@bot.ciiic.nl               → Inbox catch-all (type: inbox)

Slack:
  📌 Pushpin reaction           → Auto-detect and add to Notion
  Right-click → "Add to Notion" → Modal with type selection

Configure your email service to POST all *@bot.ciiic.nl to:
  https://bot.ciiic.nl/webhook/email
`);
});
