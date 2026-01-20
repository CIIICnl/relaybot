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

const NEWSLETTER_ITEM_PROMPT = `You are an assistant that extracts newsletter item information from forwarded emails.
The user is forwarding content they want to include in a newsletter. Extract the following fields and return them as JSON:

- title: string (required) - A concise, catchy title for the newsletter item (max 100 characters)
- beschrijving: string (required) - A short description/summary suitable for a newsletter (1-3 sentences, in Dutch if the content is Dutch)
- url: string or null - The main URL mentioned in the email, or null if no URL is found
- forwarderName: string (required) - The name of the person who forwarded/sent this email to the bot. Look at the "Email from:" line at the top, email signatures, or "From:" headers. Extract just the first name if possible.
- originalSenderName: string or null - If this is a forwarded message, extract the original sender's name (the person who sent the tip/info originally, before it was forwarded). Look for forwarded message headers like "From:", "Van:", "Begin forwarded message", or signatures. Just the first name if possible.
- topicSummary: string (required) - A brief summary of what the content is about in Dutch (e.g., "subsidieoproep AI", "nieuwe tentoonstelling", "workshop aankondiging"). Keep it concise, max 50 characters.

Important:
- The email may be messy with forwarding headers, signatures, etc. - that's fine, extract what you can
- Extract the most relevant URL (e.g., an article link, event page, registration link)
- The description should be engaging and informative for newsletter readers
- If the email is in Dutch, keep the description in Dutch
- For names, prefer first names only (e.g., "Jaap" not "Jaap Stronks", "Isjah" not "Isjah Koppejan")

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

export async function parseNewsletterItemFromEmail(emailContent, senderEmail = null) {
  const userMessage = senderEmail
    ? `Email from: ${senderEmail}\n\n${emailContent}`
    : emailContent;

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
