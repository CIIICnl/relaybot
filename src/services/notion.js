import { Client } from '@notionhq/client';

const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

const DATABASE_ID = process.env.NOTION_EVENTS_DATABASE_ID;

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
