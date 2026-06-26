/**
 * Notification Service — Mock Twilio / WhatsApp Integration
 *
 * In production, replace the sendSMS function body with real Twilio calls:
 *   const twilio = require('twilio')(ACCOUNT_SID, AUTH_TOKEN);
 *   await twilio.messages.create({ body, from: TWILIO_NUMBER, to: phone });
 *
 * Notifications are fully logged to the DB regardless of whether real SMS fires.
 */

const { q } = require('./db');

// Colorised console output to simulate SMS delivery in dev
function mockSend(to, message) {
  const ts = new Date().toLocaleTimeString();
  console.log('\x1b[36m%s\x1b[0m', `📱 [SMS ${ts}] → ${to}`);
  console.log('\x1b[33m%s\x1b[0m', `   ${message}`);
}

function logAndSend(eventId, type, phone, message) {
  mockSend(phone, message);
  q.logNotification({ event_id: eventId, type, recipient: phone, message });
}

// ── Notification Triggers ─────────────────────────────────────────────────────

/**
 * Sent to every guest when a new event is created.
 * Message includes their personal RSVP link.
 */
function notifyGuestsOnCreate(event, guests, baseUrl) {
  for (const guest of guests) {
    const link = `${baseUrl}/event/${event.id}?g=${guest.guest_token}`;
    const msg =
      `Hi ${guest.name}! 🍽️ You're invited to "${event.name}" ` +
      `on ${formatDate(event.date)} at ${event.time}. ` +
      `📍 ${event.location}. ` +
      `RSVP & pick your dish here: ${link}`;
    logAndSend(event.id, 'invite', guest.phone, msg);
  }
}

/**
 * Sent to the host when a guest RSVPs.
 */
function notifyHostOnRSVP(event, guest) {
  const status = guest.rsvp === 'yes'
    ? `✅ coming (+${guest.headcount - 1} extra)`
    : '❌ can\'t make it';
  const msg =
    `[Plan The Potluck] ${guest.name} just RSVP'd ${status} for "${event.name}".` +
    (guest.dish ? ` They're bringing: ${guest.dish}.` : '');
  logAndSend(event.id, 'rsvp_host', event.host_phone, msg);
}

/**
 * Sent to the host when a guest updates their dish.
 */
function notifyHostOnDishUpdate(event, guest) {
  const msg =
    `[Plan The Potluck] ${guest.name} updated their dish for "${event.name}": ` +
    `${guest.dish || '(removed)'}`;
  logAndSend(event.id, 'dish_host', event.host_phone, msg);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

module.exports = { notifyGuestsOnCreate, notifyHostOnRSVP, notifyHostOnDishUpdate };
