/**
 * SXSW London 2026 newsletter opt-in
 *
 * Receives the Gravity Forms webhook from Form 26 (public) and Form 27
 * (roundtable). When the "Stay informed" checkbox is ticked, subscribes
 * the contact to the main CIIIC Mailchimp list.
 */

import https from 'https';
import crypto from 'crypto';

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_DC = process.env.MAILCHIMP_DC || 'us11';
const MAILCHIMP_CIIIC_LIST_ID = process.env.MAILCHIMP_CIIIC_LIST_ID || '67fe159b9d';

// Form-id → field-id mapping. Lets us extract the same logical fields
// regardless of which form fired the webhook.
const FIELD_MAP = {
  26: { firstName: '1', lastName: '2', email: '5', newsletter: '9' },
  27: { firstName: '2', lastName: '3', email: '6', newsletter: '11' },
};

function apiRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function subscribeToMailchimp({ email, firstName, lastName, source }) {
  const auth = Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
  };
  const emailHash = crypto
    .createHash('md5')
    .update(email.toLowerCase().trim())
    .digest('hex');

  // PUT upserts: keeps existing subscribers, adds new ones.
  const result = await apiRequest(
    `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_CIIIC_LIST_ID}/members/${emailHash}`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        email_address: email.toLowerCase().trim(),
        status_if_new: 'subscribed',
        merge_fields: {
          FNAME: firstName || '',
          LNAME: lastName || '',
        },
        tags: [source].filter(Boolean),
      }),
    }
  );

  if (result.status >= 400) {
    throw new Error(
      `Mailchimp error ${result.status}: ${JSON.stringify(result.data)}`
    );
  }
  return result.data;
}

/**
 * Process a Gravity Forms webhook payload from Form 26 or 27.
 * Returns { skipped: true } when the opt-in checkbox is empty.
 */
export async function processSxswSubmission(body) {
  const formId = String(body.form_id || body.formId || '').trim();
  const map = FIELD_MAP[formId];
  if (!map) {
    throw new Error(`Unknown SXSW form id: ${formId}`);
  }

  const email = (body[map.email] || '').trim();
  const firstName = (body[map.firstName] || '').trim();
  const lastName = (body[map.lastName] || '').trim();
  const newsletter = (body[map.newsletter] || '').trim();

  if (!email) {
    throw new Error('No email address in SXSW payload');
  }

  const source = formId === '26' ? 'sxsw-london-2026-public' : 'sxsw-london-2026-roundtable';
  const optedIn = Boolean(newsletter);

  console.log(
    `📝 SXSW (${source}): ${firstName} ${lastName} <${email}> opt-in=${optedIn}`
  );

  if (!optedIn) {
    return { skipped: true, reason: 'no_optin', email };
  }

  const mc = await subscribeToMailchimp({ email, firstName, lastName, source });
  console.log(`✅ Mailchimp CIIIC: ${email} subscribed (tag: ${source})`);
  return { subscribed: true, email, source, mailchimp_status: mc.status };
}
