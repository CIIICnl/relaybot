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

Important:
- Parse dates intelligently (e.g., "next Friday", "15 januari", "March 3rd 2025")
- If the year is not specified, assume the next occurrence of that date
- Extract URLs from the email content
- If the email is in Dutch, keep the description in Dutch
- If uncertain about a field, set it to null rather than guessing

Return ONLY valid JSON, no markdown formatting or explanation.`;

const NEWSLETTER_ITEM_PROMPT = `You are an assistant that extracts newsletter item information from forwarded emails.
The user is forwarding content they want to include in a newsletter. Extract the following fields and return them as JSON:

- title: string (required) - A concise, catchy title for the newsletter item (max 100 characters)
- beschrijving: string (required) - A short description/summary suitable for a newsletter (1-3 sentences, in Dutch if the content is Dutch)
- url: string or null - The main URL mentioned in the email, or null if no URL is found
- originalSender: string or null - If this is a forwarded message, extract the original sender's name or email (the person who sent the tip/info originally, before it was forwarded). Look for "From:", "Van:", forwarded message headers, or signatures.
- topicSummary: string (required) - A brief summary of what the content is about (e.g., "store opening on March 1st", "new art exhibition", "workshop announcement"). Keep it concise, max 50 characters.

Important:
- The email may be a forwarded message - look for the actual content being shared
- Extract the most relevant URL (e.g., an article link, event page, registration link)
- The description should be engaging and informative for newsletter readers
- If the email is in Dutch, keep the description in Dutch
- If uncertain about a field, use a sensible default rather than null (except for URL and originalSender)
- For originalSender, only fill this if you can clearly identify someone other than the forwarder sent the original content

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
