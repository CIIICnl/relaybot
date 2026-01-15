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
