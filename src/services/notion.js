import { Client } from '@notionhq/client';

const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

const DATABASE_ID = process.env.NOTION_EVENTS_DATABASE_ID;
const CONTENT_DATABASE_ID = process.env.NOTION_CONTENT_DATABASE_ID;
const INBOX_DATABASE_ID = process.env.NOTION_INBOX_DATABASE_ID;

/**
 * Creates an event in the Notion database
 * @param {Object} eventData - Parsed event data from OpenAI
 * @returns {Object} - Created Notion page with URL
 */
export async function createEvent(eventData) {
  const {
    eventName,
    eventDate,
    eventTime,
    endDate,
    endTime,
    venue,
    eventUrl,
    beschrijving,
    publishToSite,
  } = eventData;

  // Build the date property
  const dateProperty = buildDateProperty(eventDate, eventTime, endDate, endTime);

  // Build the properties object
  const properties = {
    'Event name': {
      title: [
        {
          text: {
            content: eventName || 'Untitled Event',
          },
        },
      ],
    },
    'Event date': dateProperty,
    'site / nieuwsbrief': {
      checkbox: publishToSite ?? false,
    },
  };

  // Add optional fields if present
  if (venue) {
    properties['Venue'] = {
      rich_text: [
        {
          text: {
            content: venue,
          },
        },
      ],
    };
  }

  if (eventUrl) {
    properties['Event URL'] = {
      url: eventUrl,
    };
  }

  if (beschrijving) {
    properties['Beschrijving'] = {
      rich_text: [
        {
          text: {
            content: beschrijving,
          },
        },
      ],
    };
  }

  const response = await notion.pages.create({
    parent: {
      database_id: DATABASE_ID,
    },
    properties,
  });

  return {
    id: response.id,
    url: response.url,
  };
}

/**
 * Get Amsterdam timezone offset for a given date (CET/CEST)
 */
function getAmsterdamOffset(dateStr) {
  const date = new Date(dateStr);
  const year = date.getFullYear();

  // DST starts last Sunday of March at 02:00, ends last Sunday of October at 03:00
  const marchLast = new Date(year, 2, 31);
  const dstStart = new Date(year, 2, 31 - marchLast.getDay(), 2, 0);

  const octLast = new Date(year, 9, 31);
  const dstEnd = new Date(year, 9, 31 - octLast.getDay(), 3, 0);

  // CEST (summer): +02:00, CET (winter): +01:00
  return (date >= dstStart && date < dstEnd) ? '+02:00' : '+01:00';
}

/**
 * Builds a Notion date property with optional time and end date
 * Times are interpreted as Amsterdam time (CET/CEST)
 */
function buildDateProperty(startDate, startTime, endDate, endTime) {
  if (!startDate) {
    return { date: null };
  }

  let start = startDate;
  if (startTime) {
    const offset = getAmsterdamOffset(startDate);
    start = `${startDate}T${startTime}:00${offset}`;
  }

  const dateObject = { start };

  // Add end date/time if different from start
  if (endDate || endTime) {
    let end = endDate || startDate;
    if (endTime) {
      const offset = getAmsterdamOffset(end);
      end = `${end}T${endTime}:00${offset}`;
    } else if (startTime && !endTime && endDate) {
      // If start has time but end doesn't, don't add time to end
      // Just use the date
    }

    // Only add end if it's actually different or has time info
    if (end !== start) {
      dateObject.end = end;
    }
  }

  return { date: dateObject };
}

/**
 * Get the next Thursday from today (or today if it's Thursday)
 * @returns {Date} - The next Thursday
 */
export function getNextThursday() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday, 4 = Thursday
  const daysUntilThursday = (4 - dayOfWeek + 7) % 7;

  // If today is Thursday, return next Thursday (7 days)
  const daysToAdd = daysUntilThursday === 0 ? 7 : daysUntilThursday;

  const nextThursday = new Date(today);
  nextThursday.setDate(today.getDate() + daysToAdd);
  return nextThursday;
}

/**
 * Get ISO week number for a date
 * @param {Date} date - The date to get the week number for
 * @returns {number} - ISO week number (1-53)
 */
export function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Format date as YYYY-MM-DD
 * @param {Date} date - The date to format
 * @returns {string} - Formatted date string
 */
export function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Find a newsletter item by title (e.g., "Nieuwsbrief week 5")
 * @param {number} weekNumber - The week number to search for
 * @returns {Object|null} - The found page or null
 */
export async function findNewsletterItem(weekNumber) {
  const searchTitle = `Nieuwsbrief week ${weekNumber}`;

  try {
    const response = await notion.databases.query({
      database_id: CONTENT_DATABASE_ID,
      filter: {
        property: 'Titel',
        title: {
          equals: searchTitle,
        },
      },
    });

    if (response.results.length > 0) {
      return {
        id: response.results[0].id,
        title: searchTitle,
      };
    }

    return null;
  } catch (error) {
    console.error(`Failed to find newsletter item: ${error.message}`);
    return null;
  }
}

/**
 * Creates a content item in the Notion content database
 * @param {Object} contentData - The content data
 * @returns {Object} - Created Notion page with URL
 */
export async function createContentItem(contentData) {
  const {
    title,
    beschrijving,
    url,
  } = contentData;

  // Calculate next Thursday and week number
  const nextThursday = getNextThursday();
  const weekNumber = getWeekNumber(nextThursday);
  const publicatieDatum = formatDate(nextThursday);

  // Build the properties object
  const properties = {
    'Titel': {
      title: [
        {
          text: {
            content: title || 'Nieuwsbrief item',
          },
        },
      ],
    },
    'Publicatiedatum': {
      date: {
        start: publicatieDatum,
      },
    },
    'Platform': {
      multi_select: [
        {
          name: 'E-mail-onderdeel',
        },
      ],
    },
  };

  // Add description if present
  if (beschrijving) {
    properties['Beschrijving'] = {
      rich_text: [
        {
          text: {
            content: beschrijving.substring(0, 2000), // Notion limit
          },
        },
      ],
    };
  }

  // Add URL if present
  if (url) {
    properties['URL'] = {
      url: url,
    };
  }

  // Find the newsletter item for the relationship
  const newsletterItem = await findNewsletterItem(weekNumber);
  if (newsletterItem) {
    properties['In Nieuwsbrief'] = {
      relation: [
        {
          id: newsletterItem.id,
        },
      ],
    };
    console.log(`🔗 Linking to newsletter: ${newsletterItem.title}`);
  } else {
    console.warn(`⚠️ Could not find "Nieuwsbrief week ${weekNumber}" - relationship not set`);
  }

  const response = await notion.pages.create({
    parent: {
      database_id: CONTENT_DATABASE_ID,
    },
    properties,
  });

  return {
    id: response.id,
    url: response.url,
    weekNumber,
    publicatieDatum,
    linkedNewsletter: newsletterItem?.title || null,
  };
}

/**
 * Add a comment to a Notion page
 * @param {string} pageId - The page ID to add the comment to
 * @param {string} comment - The comment text
 */
export async function addComment(pageId, comment) {
  try {
    await notion.comments.create({
      parent: {
        page_id: pageId,
      },
      rich_text: [
        {
          text: {
            content: comment.substring(0, 2000), // Notion limit
          },
        },
      ],
    });
    console.log('💬 Comment added to page');
  } catch (error) {
    console.error(`Failed to add comment: ${error.message}`);
    // Don't throw - comment is not critical
  }
}

/**
 * Test connection to Notion
 */
export async function testConnection() {
  try {
    const database = await notion.databases.retrieve({
      database_id: DATABASE_ID,
    });
    return {
      success: true,
      databaseTitle: database.title?.[0]?.plain_text || 'Unknown',
      properties: Object.keys(database.properties),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}
