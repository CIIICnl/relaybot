import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are an assistant that extracts event information from emails.
Extract the following fields from the email content and return them as JSON:

- eventName: string (required) - The name/title of the event
- eventDate: string (required) - Start date in ISO 8601 format (YYYY-MM-DD)
- eventTime: string or null - Start time in HH:MM format (24h), or null if not specified
- endDate: string or null - End date in ISO 8601 format, or null if same as start or not specified
- endTime: string or null - End time in HH:MM format (24h), or null if not specified
- venue: string or null - Location/venue name, or null if not specified
- eventUrl: string or null - URL for more info or registration, or null if not specified
- beschrijving: string or null - A one-paragraph description in Dutch if possible, or null if not enough info
- publishToSite: boolean - Default to true (publish on website/newsletter). Only set to false if explicitly stated the event should NOT be published or is private/internal
- senderName: string (required) - The name of the person who sent/forwarded this email. Look at the "Email from:" line, email signatures, "From:" headers, etc. Extract just the first name if possible.

Important:
- Parse dates intelligently (e.g., "next Friday", "15 januari", "March 3rd 2025")
- If the year is not specified, assume the next occurrence of that date
- Extract URLs from the email content
- If the email is in Dutch, keep the description in Dutch
- The email may be messy with forwarding headers, signatures, etc. - that's fine, extract what you can
- For names, prefer first names only (e.g., "Jaap" not "Jaap Stronks")
- If uncertain about a field, set it to null rather than guessing

Return ONLY valid JSON, no markdown formatting or explanation.`;

const CIIIC_CONTEXT = `Context about the newsletter audience:
CIIIC (Creative Industries Immersive Impact Coalition) is a Dutch national program supporting immersive experiences (IX) - AR/VR/XR, virtual worlds, spatial computing. The newsletter goes to makers, researchers, companies and organizations in this field.

Relevant topics include:
- Funding calls, subsidies, grants (especially EU/Dutch funding for creative tech, AI, immersive tech)
- Events: conferences, meetups, workshops about IX/XR/VR/AR
- Research and innovation in immersive technologies
- Virtual worlds, metaverse, spatial computing developments
- AI applications in creative industries
- Policy developments affecting the IX sector

Key organizations in our network: Stimuleringsfonds, TNO, NWO-SIA, RVO, ClickNL.
`;

const NEWSLETTER_ITEM_PROMPT = `You are an assistant helping CIIIC curate content for their newsletter about immersive experiences (IX/XR/VR/AR).

${CIIIC_CONTEXT}

Extract the following fields from the forwarded email and return them as JSON:

- title: string (required) - A concise, catchy title for the newsletter item (max 100 characters, in Dutch)
- beschrijving: string (required) - A short description explaining what this is AND why it's relevant for the CIIIC audience (2-3 sentences, in Dutch). Highlight the IX/XR/VR/AR angle if present.
- url: string or null - The main URL mentioned in the email, or null if no URL is found
- forwarderName: string (required) - The name of the person who forwarded/sent this email to the bot. Look at the "Email from:" line at the top, email signatures, or "From:" headers. Extract just the first name if possible.
- originalSenderName: string or null - If this is a forwarded message, extract the original sender's name (the person who sent the tip/info originally). Just the first name if possible.
- topicSummary: string (required) - A brief summary in Dutch (e.g., "EU subsidieoproep AI en XR", "VR conferentie"). Max 50 characters.
- relevanceNote: string or null - If the content seems tangentially relevant (e.g., general AI funding that includes XR), briefly note why it might be relevant for the IX community.

Important:
- The email may be messy with forwarding headers, signatures, etc. - extract what you can
- If URL content is provided, use it to write a better, more informed description
- The description should be engaging and highlight relevance to immersive tech where applicable
- Write in Dutch
- For names, prefer first names only

Return ONLY valid JSON, no markdown formatting or explanation.`;

export async function parseEventFromEmail(emailContent, senderEmail = null) {
  const userMessage = senderEmail
    ? `Email from: ${senderEmail}\n\n${emailContent}`
    : emailContent;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const content = completion.choices[0].message.content;

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse OpenAI response as JSON: ${content}`);
  }
}

const INBOX_ITEM_PROMPT = `You are an assistant that extracts key information from emails for an inbox/catch-all system.
Extract the following fields and return them as JSON:

- name: string (required) - A concise title/name for this item (max 100 characters)
- description: string (required) - A brief summary of what the email is about (1-3 sentences, in Dutch if the content is Dutch)
- url: string or null - The main URL mentioned in the email, or null if no URL is found
- senderName: string (required) - The name of the person who sent this email. Look at the "Email from:" line, email signatures, "From:" headers, etc. Extract just the first name if possible.

Important:
- Keep the name short but descriptive
- The description should capture the essence of the email
- If the email is in Dutch, keep the description in Dutch
- The email may be messy with headers, signatures, etc. - that's fine, extract what you can
- For names, prefer first names only (e.g., "Jaap" not "Jaap Stronks")

Return ONLY valid JSON, no markdown formatting or explanation.`;

export async function parseInboxItemFromEmail(emailContent, senderEmail = null) {
  const userMessage = senderEmail
    ? `Email from: ${senderEmail}\n\n${emailContent}`
    : emailContent;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: INBOX_ITEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const content = completion.choices[0].message.content;

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse OpenAI response as JSON: ${content}`);
  }
}

/**
 * Extract URLs from text
 */
export function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = text.match(urlRegex) || [];
  // Clean up trailing punctuation
  return matches.map(url => url.replace(/[.,;:!?)]+$/, ''));
}

/**
 * Fetch and extract text content from a URL
 * Returns null if fetching fails (graceful degradation)
 */
export async function fetchUrlContent(url, timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CIIICBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`⚠️ Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Basic HTML to text conversion
    let text = html
      // Remove script and style blocks
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // Convert common elements
      .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, 'Title: $1\n')
      .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n$1\n')
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Remove remaining tags
      .replace(/<[^>]+>/g, '')
      // Decode entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Clean up whitespace
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();

    // Limit length to avoid token overflow
    if (text.length > 3000) {
      text = text.substring(0, 3000) + '...[truncated]';
    }

    console.log(`📄 Fetched ${url}: ${text.length} chars`);
    return text;
  } catch (error) {
    console.log(`⚠️ Error fetching ${url}: ${error.message}`);
    return null;
  }
}

export async function parseNewsletterItemFromEmail(emailContent, senderEmail = null, urlContent = null) {
  let userMessage = senderEmail
    ? `Email from: ${senderEmail}\n\n${emailContent}`
    : emailContent;

  // Append URL content if available
  if (urlContent) {
    userMessage += `\n\n---\nContent fetched from the URL mentioned in the email:\n${urlContent}`;
  }

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: NEWSLETTER_ITEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const content = completion.choices[0].message.content;

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse OpenAI response as JSON: ${content}`);
  }
}
