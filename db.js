/**
 * db.js — lightweight JSON-file datastore (no native compilation required)
 *
 * In production you can swap this for better-sqlite3 / PostgreSQL by
 * keeping the same exported interface: { q, getFullEvent, createEventWithGuests }
 */

const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'potluck-db.json');

// ── In-memory store ───────────────────────────────────────────────────────────
let store = { events: {}, guests: {}, notification_log: [] };

function loadStore() {
  try {
    if (fs.existsSync(DB_FILE)) {
      store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch { /* first run — start fresh */ }
}

function saveStore() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { console.error('DB write error:', e.message); }
}

loadStore();

// ── Query helpers ─────────────────────────────────────────────────────────────
const q = {
  getEventById(id) { return store.events[id] || null; },

  getEventByHostToken(token) {
    return Object.values(store.events).find(e => e.host_token === token) || null;
  },

  insertEvent(data) {
    store.events[data.id] = { ...data, created_at: new Date().toISOString() };
    saveStore();
  },

  updateEvent({ id, host_token, name, date, time, location, description }) {
    const ev = store.events[id];
    if (!ev || ev.host_token !== host_token) return;
    Object.assign(ev, { name, date, time, location, description });
    saveStore();
  },

  insertGuest(data) {
    store.guests[data.id] = { ...data, updated_at: new Date().toISOString() };
    saveStore();
  },

  getGuestsByEvent(eventId) {
    return Object.values(store.guests)
      .filter(g => g.event_id === eventId)
      .sort((a,b) => a.name.localeCompare(b.name));
  },

  getGuestByToken(token) {
    return Object.values(store.guests).find(g => g.guest_token === token) || null;
  },

  getGuestById(id) { return store.guests[id] || null; },

  updateGuestRSVP({ guest_token, rsvp, headcount }) {
    const g = Object.values(store.guests).find(g => g.guest_token === guest_token);
    if (!g) return;
    Object.assign(g, { rsvp, headcount: parseInt(headcount) || 1, updated_at: new Date().toISOString() });
    saveStore();
  },

  updateGuestDish({ guest_token, dish, dish_category }) {
    const g = Object.values(store.guests).find(g => g.guest_token === guest_token);
    if (!g) return;
    Object.assign(g, { dish, dish_category, updated_at: new Date().toISOString() });
    saveStore();
  },

  logNotification({ event_id, type, recipient, message }) {
    store.notification_log.push({ event_id, type, recipient, message, sent_at: new Date().toISOString() });
    // Trim log to last 500 entries to avoid unbounded growth
    if (store.notification_log.length > 500) store.notification_log = store.notification_log.slice(-500);
    saveStore();
  },
};

// ── Compound helpers ──────────────────────────────────────────────────────────
function getFullEvent(eventId) {
  const event = q.getEventById(eventId);
  if (!event) return null;
  const guests = q.getGuestsByEvent(eventId);
  return { ...event, guests };
}

function createEventWithGuests(eventData, guestList) {
  const { v4: uuidv4 } = require('uuid');
  q.insertEvent(eventData);
  for (const g of guestList) {
    q.insertGuest({
      id:          uuidv4(),
      event_id:    eventData.id,
      guest_token: uuidv4(),
      name:        g.name,
      phone:       g.phone,
      rsvp:        'pending',
      headcount:   1,
      dish:        '',
      dish_category: '',
    });
  }
  return getFullEvent(eventData.id);
}

module.exports = { q, getFullEvent, createEventWithGuests };
