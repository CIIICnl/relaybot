import crypto from 'crypto';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

/**
 * Verify that a request came from Slack
 * @param {Object} req - Express request object
 * @returns {boolean} - Whether the signature is valid
 */
export function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) {
    console.error('SLACK_SIGNING_SECRET not configured');
    return false;
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  if (!timestamp || !signature) {
    return false;
  }

  // Prevent replay attacks - request must be within 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) {
    return false;
  }

  // Compute the signature
  const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(sigBasestring, 'utf8')
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(mySignature, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
}

/**
 * Call the Slack API
 * @param {string} method - API method (e.g., 'chat.postMessage')
 * @param {Object} body - Request body
 * @returns {Object} - API response
 */
async function slackApi(method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Slack API error (${method}): ${data.error}`);
  }

  return data;
}

/**
 * Get message content from a channel
 * @param {string} channel - Channel ID
 * @param {string} messageTs - Message timestamp
 * @returns {Object} - Message data
 */
export async function getMessage(channel, messageTs) {
  const data = await slackApi('conversations.history', {
    channel,
    latest: messageTs,
    limit: 1,
    inclusive: true,
  });

  return data.messages?.[0] || null;
}

/**
 * Get permalink for a message
 * @param {string} channel - Channel ID
 * @param {string} messageTs - Message timestamp
 * @returns {string} - Permalink URL
 */
export async function getMessagePermalink(channel, messageTs) {
  const data = await slackApi('chat.getPermalink', {
    channel,
    message_ts: messageTs,
  });

  return data.permalink;
}

/**
 * Post a message to a channel or thread
 * @param {string} channel - Channel ID
 * @param {Object} options - Message options
 * @returns {Object} - API response
 */
export async function postMessage(channel, options) {
  return slackApi('chat.postMessage', {
    channel,
    ...options,
  });
}

/**
 * Post an ephemeral message (only visible to one user)
 * @param {string} channel - Channel ID
 * @param {string} user - User ID
 * @param {Object} options - Message options
 * @returns {Object} - API response
 */
export async function postEphemeral(channel, user, options) {
  return slackApi('chat.postEphemeral', {
    channel,
    user,
    ...options,
  });
}

/**
 * Update a message
 * @param {string} channel - Channel ID
 * @param {string} ts - Message timestamp
 * @param {Object} options - Message options
 * @returns {Object} - API response
 */
export async function updateMessage(channel, ts, options) {
  return slackApi('chat.update', {
    channel,
    ts,
    ...options,
  });
}

/**
 * Add a reaction to a message
 * @param {string} channel - Channel ID
 * @param {string} timestamp - Message timestamp
 * @param {string} emoji - Emoji name (without colons)
 */
export async function addReaction(channel, timestamp, emoji) {
  try {
    await slackApi('reactions.add', {
      channel,
      timestamp,
      name: emoji,
    });
  } catch (error) {
    // Ignore "already_reacted" errors
    if (!error.message.includes('already_reacted')) {
      throw error;
    }
  }
}

/**
 * Open a modal
 * @param {string} triggerId - Trigger ID from the interaction
 * @param {Object} view - Modal view definition
 * @returns {Object} - API response
 */
export async function openModal(triggerId, view) {
  return slackApi('views.open', {
    trigger_id: triggerId,
    view,
  });
}

/**
 * Get user info
 * @param {string} userId - User ID
 * @returns {Object} - User info
 */
export async function getUserInfo(userId) {
  const data = await slackApi('users.info', {
    user: userId,
  });

  return data.user;
}

/**
 * Test Slack connection
 * @returns {Object} - Connection status
 */
export async function testConnection() {
  try {
    const data = await slackApi('auth.test', {});
    return {
      success: true,
      botId: data.bot_id,
      teamName: data.team,
      botName: data.user,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================
// Block Kit Builders
// ============================================

/**
 * Build the "Add to Notion" modal
 * @param {Object} options - Modal options
 * @returns {Object} - Modal view definition
 */
export function buildAddToNotionModal({ messageText, detectedUrl, suggestedType, channel, messageTs }) {
  return {
    type: 'modal',
    callback_id: 'add_to_notion_modal',
    private_metadata: JSON.stringify({ channel, messageTs }),
    title: {
      type: 'plain_text',
      text: 'Add to Notion',
    },
    submit: {
      type: 'plain_text',
      text: 'Add to Notion',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: detectedUrl
            ? `*URL detected:*\n${detectedUrl}`
            : '*Message content:*\n' + (messageText?.substring(0, 200) || '(empty)') + (messageText?.length > 200 ? '...' : ''),
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'input',
        block_id: 'content_type',
        label: {
          type: 'plain_text',
          text: 'Type',
        },
        element: {
          type: 'static_select',
          action_id: 'content_type_select',
          initial_option: {
            text: {
              type: 'plain_text',
              text: suggestedType === 'event' ? 'Event' : suggestedType === 'newsletter' ? 'Newsletter item' : 'Auto-detect (recommended)',
            },
            value: suggestedType || 'auto',
          },
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Auto-detect (recommended)',
              },
              value: 'auto',
            },
            {
              text: {
                type: 'plain_text',
                text: 'Event',
              },
              value: 'event',
            },
            {
              text: {
                type: 'plain_text',
                text: 'Newsletter item',
              },
              value: 'newsletter',
            },
          ],
        },
      },
    ],
  };
}

/**
 * Build confirmation message blocks for successful creation
 * @param {Object} options - Message options
 * @returns {Object[]} - Block Kit blocks
 */
export function buildSuccessMessage({ type, title, notionUrl, details }) {
  const emoji = type === 'event' ? '📅' : '📰';
  const typeLabel = type === 'event' ? 'Event' : 'Newsletter item';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *Added to Notion*\n\n${emoji} *${typeLabel}:* ${title}`,
      },
    },
  ];

  // Add details if provided
  if (details) {
    let detailText = '';
    if (details.eventDate) {
      detailText += `🗓️ ${details.eventDate}\n`;
    }
    if (details.venue) {
      detailText += `📍 ${details.venue}\n`;
    }
    if (details.weekNumber) {
      detailText += `📅 Nieuwsbrief week ${details.weekNumber}\n`;
    }

    if (detailText) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: detailText.trim(),
          },
        ],
      });
    }
  }

  // Add button to view in Notion
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'View in Notion ↗',
          emoji: true,
        },
        url: notionUrl,
        action_id: 'view_in_notion',
      },
    ],
  });

  return blocks;
}

/**
 * Build error message blocks
 * @param {string} error - Error message
 * @returns {Object[]} - Block Kit blocks
 */
export function buildErrorMessage(error) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❌ *Failed to add to Notion*\n\n${error}`,
      },
    },
  ];
}

/**
 * Build type selection buttons (for when AI is uncertain)
 * @param {string} messageTs - Original message timestamp
 * @param {string} channel - Channel ID
 * @returns {Object[]} - Block Kit blocks
 */
export function buildTypeSelectionMessage(messageTs, channel) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "I'm not sure what type of content this is. Please select:",
      },
    },
    {
      type: 'actions',
      block_id: `type_select_${messageTs}`,
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📅 Event',
            emoji: true,
          },
          value: JSON.stringify({ type: 'event', channel, messageTs }),
          action_id: 'select_type_event',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📰 Newsletter item',
            emoji: true,
          },
          value: JSON.stringify({ type: 'newsletter', channel, messageTs }),
          action_id: 'select_type_newsletter',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Cancel',
            emoji: true,
          },
          value: 'cancel',
          action_id: 'select_type_cancel',
          style: 'danger',
        },
      ],
    },
  ];
}

/**
 * Build processing message
 * @returns {Object[]} - Block Kit blocks
 */
export function buildProcessingMessage() {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⏳ Adding to Notion...',
      },
    },
  ];
}
