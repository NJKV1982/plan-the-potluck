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
let store = { events: {}, guests: {}, dish_slots: {}, notification_log: [] };

function loadStore() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // Migrate older stores that don't have dish_slots
      store = { dish_slots: {}, ...loaded };
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

  updateGuestPhone({ guest_token, phone }) {
    const g = Object.values(store.guests).find(g => g.guest_token === guest_token);
    if (!g) return;
    Object.assign(g, { phone, updated_at: new Date().toISOString() });
    saveStore();
  },

  updateGuestDish({ guest_token, dish, dish_category }) {
    const g = Object.values(store.guests).find(g => g.guest_token === guest_token);
    if (!g) return;
    Object.assign(g, { dish, dish_category, updated_at: new Date().toISOString() });
    saveStore();
  },

  // ── Dish Slots ──────────────────────────────────────────────────────────────

  insertDishSlot({ id, event_id, name, category }) {
    store.dish_slots[id] = {
      id, event_id,
      name,
      category: category || '',
      claimed_by_guest_token: null,
      claimed_by_name: null,
      created_at: new Date().toISOString(),
    };
    saveStore();
  },

  getDishSlotsByEvent(eventId) {
    return Object.values(store.dish_slots)
      .filter(s => s.event_id === eventId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  getDishSlotById(id) { return store.dish_slots[id] || null; },

  claimDishSlot({ id, guest_token, claimed_by_name }) {
    const slot = store.dish_slots[id];
    if (!slot) return null;
    Object.assign(slot, { claimed_by_guest_token: guest_token, claimed_by_name });
    saveStore();
    return slot;
  },

  unclaimDishSlot(id) {
    const slot = store.dish_slots[id];
    if (!slot) return null;
    Object.assign(slot, { claimed_by_guest_token: null, claimed_by_name: null });
    saveStore();
    return slot;
  },

  deleteDishSlot(id) {
    delete store.dish_slots[id];
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
  const guests    = q.getGuestsByEvent(eventId);
  const dish_slots = q.getDishSlotsByEvent(eventId);
  return { ...event, guests, dish_slots };
}

function createEventWithGuests(eventData, guestList, dishSlotList = []) {
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
  for (const s of dishSlotList) {
    if (s.name && s.name.trim()) {
      q.insertDishSlot({
        id:       uuidv4(),
        event_id: eventData.id,
        name:     s.name.trim(),
        category: s.category || '',
      });
    }
  }
  return getFullEvent(eventData.id);
}

module.exports = { q, getFullEvent, createEventWithGuests };
