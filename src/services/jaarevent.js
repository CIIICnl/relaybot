/**
 * Jaarevent 2026 Registration Sync
 * 
 * Syncs registration status between Gravity Forms, Mailchimp, and Notion.
 * 
 * Flows:
 * 1. New registration (GF webhook) → Mailchimp JAAREVENT=geregistreerd + Notion jaarevent-2026=geregistreerd
 * 2. Cancellation (GF mu-plugin) → Mailchimp JAAREVENT=geannuleerd + Notion jaarevent-2026=geannuleerd
 * 3. Check-in (future) → Notion jaarevent-2026=aanwezig
 */

import https from 'https';
import crypto from 'crypto';

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_DC = process.env.MAILCHIMP_DC || 'us11';
const MAILCHIMP_LIST_ID = process.env.MAILCHIMP_JAAREVENT_LIST_ID || '67fe159b9d';

const NOTION_SECRET = process.env.NOTION_SECRET;
const NOTION_CONTACTEN_DS_IDS = (process.env.NOTION_CONTACTEN_DS_IDS || '20811fb08c9e80958d0d000bc8cad8c8,30411fb08c9e8051a530000ba6760e6a').split(',');

const WEBHOOK_SECRET = process.env.JAAREVENT_WEBHOOK_SECRET;

/**
 * Verify webhook signature from the mu-plugin
 */
export function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true; // skip if no secret configured
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(expected));
}

/**
 * Make an HTTPS request (no external deps needed)
 */
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
      res.on('data', (chunk) => data += chunk);
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

/**
 * Update Mailchimp member's JAAREVENT merge field
 * If addIfMissing is true and member doesn't exist, subscribe them first
 */
async function updateMailchimpStatus(email, status, { addIfMissing = false, firstName = '', lastName = '' } = {}) {
  const emailHash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  const auth = Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
  };

  const result = await apiRequest(
    `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members/${emailHash}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        merge_fields: { JAAREVENT: status },
      }),
    }
  );

  if (result.status >= 400) {
    if (result.status === 404) {
      if (addIfMissing) {
        // Subscribe the new member with JAAREVENT merge field
        console.log(`📬 Member ${email} not in Mailchimp, adding as subscriber...`);
        const addResult = await apiRequest(
          `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              email_address: email.toLowerCase().trim(),
              status: 'subscribed',
              merge_fields: {
                FNAME: firstName,
                LNAME: lastName,
                JAAREVENT: status,
              },
            }),
          }
        );

        if (addResult.status >= 400) {
          throw new Error(`Mailchimp add error ${addResult.status}: ${JSON.stringify(addResult.data)}`);
        }

        console.log(`✅ Mailchimp: ${email} added as subscriber with JAAREVENT=${status}`);
        return addResult.data;
      }

      console.log(`📬 Member ${email} not in Mailchimp, skipping (no opt-in)`);
      return { skipped: true, reason: 'not_in_list' };
    }
    throw new Error(`Mailchimp error ${result.status}: ${JSON.stringify(result.data)}`);
  }

  console.log(`✅ Mailchimp: ${email} → JAAREVENT=${status}`);
  return result.data;
}

/**
 * Find a contact in Notion by email and update jaarevent-2026 status
 */
async function updateNotionStatus(email, status) {
  const headers = {
    'Authorization': `Bearer ${NOTION_SECRET}`,
    'Notion-Version': '2025-09-03',
    'Content-Type': 'application/json',
  };

  // Search across both data sources
  let pageId = null;

  for (const dsId of NOTION_CONTACTEN_DS_IDS) {
    const searchResult = await apiRequest(
      `https://api.notion.com/v1/data_sources/${dsId}/query`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter: {
            property: '',  // unnamed email property
            email: { equals: email.toLowerCase().trim() },
          },
          page_size: 1,
        }),
      }
    );

    if (searchResult.status === 200 && searchResult.data.results?.length > 0) {
      pageId = searchResult.data.results[0].id;
      break;
    }
  }

  if (!pageId) {
    console.log(`📋 Contact ${email} not found in Notion Contacten, skipping Notion update`);
    return { skipped: true, reason: 'not_in_notion' };
  }

  // Update the jaarevent-2026 select property
  const updateResult = await apiRequest(
    `https://api.notion.com/v1/pages/${pageId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'jaarevent-2026': {
            select: { name: status },
          },
        },
      }),
    }
  );

  if (updateResult.status >= 400) {
    throw new Error(`Notion error ${updateResult.status}: ${JSON.stringify(updateResult.data)}`);
  }

  console.log(`✅ Notion: ${email} (${pageId}) → jaarevent-2026=${status}`);
  return { pageId, status };
}

/**
 * Process a new registration from Gravity Forms webhook
 * GF sends form field values keyed by field ID
 */
export async function processRegistration(body) {
  // GF webhook payload: field values by ID
  // Field 1: First name, 9: Last name, 2: Email, 3: Organisation, 11: Job title
  // Field 19: Stay informed (checkbox) — opt-in for Mailchimp newsletter
  // Field 25: Attendance, 26: IX engagement, 21/22: Track choices
  const email = body['2'] || body.email;
  const firstName = body['1'] || body.first_name || '';
  const lastName = body['9'] || body.last_name || '';
  const stayInformed = !!(body['19'] && body['19'].trim());

  if (!email) {
    throw new Error('No email address in registration payload');
  }

  console.log(`📝 Processing registration: ${firstName} ${lastName} <${email}> (opt-in: ${stayInformed})`);

  const results = { email, firstName, lastName, stayInformed };

  // Update Mailchimp — only add new subscribers if they opted in
  try {
    results.mailchimp = await updateMailchimpStatus(email, 'geregistreerd', {
      addIfMissing: stayInformed,
      firstName,
      lastName,
    });
  } catch (err) {
    console.error(`Mailchimp error for ${email}:`, err.message);
    results.mailchimpError = err.message;
  }

  // Update Notion
  try {
    results.notion = await updateNotionStatus(email, 'geregistreerd');
  } catch (err) {
    console.error(`Notion error for ${email}:`, err.message);
    results.notionError = err.message;
  }

  return results;
}

/**
 * Process a status change from the GF mu-plugin
 */
export async function processStatusChange(body) {
  const { email, status, entry_id } = body;

  if (!email || !status) {
    throw new Error('Missing email or status in status change payload');
  }

  // Map GF registration status to our status values
  const statusMap = {
    'cancelled': 'geannuleerd',
    'confirmed': 'geregistreerd',
    'active': 'geregistreerd',
  };

  const mappedStatus = statusMap[status.toLowerCase()] || status;

  console.log(`🔄 Processing status change: ${email} → ${mappedStatus} (GF entry ${entry_id})`);

  const results = { email, status: mappedStatus, entry_id };

  // Update Mailchimp
  try {
    results.mailchimp = await updateMailchimpStatus(email, mappedStatus);
  } catch (err) {
    console.error(`Mailchimp error for ${email}:`, err.message);
    results.mailchimpError = err.message;
  }

  // Update Notion
  try {
    results.notion = await updateNotionStatus(email, mappedStatus);
  } catch (err) {
    console.error(`Notion error for ${email}:`, err.message);
    results.notionError = err.message;
  }

  return results;
}

/**
 * Process a check-in scan (Notion only)
 */
export async function processCheckin(body) {
  const { email } = body;

  if (!email) {
    throw new Error('Missing email in check-in payload');
  }

  console.log(`📱 Processing check-in: ${email}`);

  const results = { email };

  // Update Mailchimp
  try {
    results.mailchimp = await updateMailchimpStatus(email, 'aanwezig');
  } catch (err) {
    console.error(`Mailchimp error for ${email}:`, err.message);
    results.mailchimpError = err.message;
  }

  // Update Notion
  try {
    results.notion = await updateNotionStatus(email, 'aanwezig');
  } catch (err) {
    console.error(`Notion error for ${email}:`, err.message);
    results.notionError = err.message;
  }

  return results;
}
