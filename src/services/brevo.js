/**
 * Brevo (Sendinblue) email sending service
 * Uses the REST API with api-key authentication
 */

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Send an email via Brevo API
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.toName - Recipient name (optional)
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - HTML content
 * @param {string} options.textContent - Plain text content (optional)
 * @param {string} options.fromEmail - Sender email (optional, defaults to noreply@ciiic.nl)
 * @param {string} options.fromName - Sender name (optional)
 */
export async function sendEmail({
  to,
  toName,
  subject,
  htmlContent,
  textContent,
  fromEmail = 'noreply@ciiic.nl',
  fromName = 'CIIIC Event Bot',
}) {
  const apiKey = process.env.BREVO_API_KEY2; // The xkeysib- key

  if (!apiKey) {
    throw new Error('BREVO_API_KEY2 not configured');
  }

  const payload = {
    sender: {
      email: fromEmail,
      name: fromName,
    },
    to: [
      {
        email: to,
        name: toName || to,
      },
    ],
    subject,
    htmlContent,
  };

  if (textContent) {
    payload.textContent = textContent;
  }

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Brevo API error (${response.status}): ${errorBody}`);
  }

  return await response.json();
}

/**
 * Send event creation confirmation email
 */
export async function sendEventConfirmation(recipientEmail, eventName, notionUrl) {
  const subject = `✅ Event aangemaakt: ${eventName}`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <h2>Event succesvol aangemaakt!</h2>
  <p>Je event <strong>${escapeHtml(eventName)}</strong> is toegevoegd aan de CIIIC agenda.</p>
  <p>
    <a href="${notionUrl}" style="display: inline-block; padding: 10px 20px; background-color: #000; color: #fff; text-decoration: none; border-radius: 4px;">
      Bekijk in Notion
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">
    Je kunt het event bewerken via de link hierboven.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <p style="color: #999; font-size: 12px;">
    Dit is een automatisch bericht van de CIIIC Event Bot.
  </p>
</body>
</html>
`;

  const textContent = `Event succesvol aangemaakt!

Je event "${eventName}" is toegevoegd aan de CIIIC agenda.

Bekijk in Notion: ${notionUrl}

Je kunt het event bewerken via de link hierboven.

---
Dit is een automatisch bericht van de CIIIC Event Bot.`;

  return sendEmail({
    to: recipientEmail,
    subject,
    htmlContent,
    textContent,
  });
}

/**
 * Send newsletter item creation confirmation email
 */
export async function sendNewsletterItemConfirmation(recipientEmail, title, notionUrl, weekNumber, publicatieDatum) {
  const subject = `✅ Nieuwsbrief item aangemaakt: ${title}`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <h2>Nieuwsbrief item succesvol aangemaakt!</h2>
  <p>Je item <strong>${escapeHtml(title)}</strong> is toegevoegd aan de content database.</p>
  <ul style="color: #666;">
    <li>Publicatiedatum: <strong>${publicatieDatum}</strong></li>
    <li>Nieuwsbrief: <strong>Week ${weekNumber}</strong></li>
  </ul>
  <p>
    <a href="${notionUrl}" style="display: inline-block; padding: 10px 20px; background-color: #000; color: #fff; text-decoration: none; border-radius: 4px;">
      Bekijk in Notion
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">
    Je kunt het item bewerken via de link hierboven.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <p style="color: #999; font-size: 12px;">
    Dit is een automatisch bericht van de CIIIC Bot.
  </p>
</body>
</html>
`;

  const textContent = `Nieuwsbrief item succesvol aangemaakt!

Je item "${title}" is toegevoegd aan de content database.

- Publicatiedatum: ${publicatieDatum}
- Nieuwsbrief: Week ${weekNumber}

Bekijk in Notion: ${notionUrl}

Je kunt het item bewerken via de link hierboven.

---
Dit is een automatisch bericht van de CIIIC Bot.`;

  return sendEmail({
    to: recipientEmail,
    subject,
    htmlContent,
    textContent,
  });
}

/**
 * Send error notification email
 */
export async function sendErrorNotification(recipientEmail, errorMessage) {
  const subject = '❌ Event kon niet worden aangemaakt';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <h2>Er ging iets mis</h2>
  <p>Je event kon niet automatisch worden aangemaakt.</p>
  <p style="background: #f5f5f5; padding: 10px; border-radius: 4px; font-family: monospace;">
    ${escapeHtml(errorMessage)}
  </p>
  <p>Probeer het opnieuw of maak het event handmatig aan in Notion.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <p style="color: #999; font-size: 12px;">
    Dit is een automatisch bericht van de CIIIC Event Bot.
  </p>
</body>
</html>
`;

  return sendEmail({
    to: recipientEmail,
    subject,
    htmlContent,
  });
}

/**
 * Test Brevo API connection
 */
export async function testConnection() {
  const apiKey = process.env.BREVO_API_KEY2;

  if (!apiKey) {
    return { success: false, error: 'BREVO_API_KEY2 not configured' };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/account', {
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, error: `API error (${response.status}): ${errorBody}` };
    }

    const account = await response.json();
    return {
      success: true,
      email: account.email,
      companyName: account.companyName,
      plan: account.plan?.[0]?.type || 'unknown',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
