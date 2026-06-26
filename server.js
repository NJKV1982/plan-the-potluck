const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { q, getFullEvent, createEventWithGuests } = require('./db');
const { notifyGuestsOnCreate, notifyHostOnRSVP, notifyHostOnDishUpdate } = require('./notifications');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE: Real-time event bus ─────────────────────────────────────────────────
const sseClients = new Map();

function broadcastEvent(eventId, data) {
  const clients = sseClients.get(eventId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* client disconnected */ }
  }
}

app.get('/api/events/:id/stream', (req, res) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id).add(res);

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(id)?.delete(res);
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/events — create new event
app.post('/api/events', (req, res) => {
  const { name, date, time, location, description, host_name, host_phone, guests, dish_slots } = req.body;

  if (!name || !date || !time || !location || !host_name || !host_phone) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const eventId   = uuidv4();
  const hostToken = uuidv4();

  const eventData = { id: eventId, host_token: hostToken, name, date, time, location,
    description: description || '', host_name, host_phone };

  const guestList    = (guests     || []).filter(g => g.name && g.phone);
  const dishSlotList = (dish_slots || []).filter(s => s.name && s.name.trim());

  const fullEvent = createEventWithGuests(eventData, guestList, dishSlotList);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  setImmediate(() => notifyGuestsOnCreate(fullEvent, fullEvent.guests, baseUrl));

  res.status(201).json({
    eventId,
    hostToken,
    eventUrl: `${baseUrl}/event/${eventId}`,
    hostUrl:  `${baseUrl}/event/${eventId}?h=${hostToken}`,
  });
});

// GET /api/events/:id — fetch full event
app.get('/api/events/:id', (req, res) => {
  const event = getFullEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const { host_token: _ht, ...publicEvent } = event;
  const isHost = req.query.h && req.query.h === event.host_token;

  res.json({ ...publicEvent, isHost });
});

// PATCH /api/events/:id — host edits event details
app.patch('/api/events/:id', (req, res) => {
  const event = q.getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const { host_token, name, date, time, location, description } = req.body;
  if (!host_token || host_token !== event.host_token)
    return res.status(403).json({ error: 'Unauthorized.' });

  q.updateEvent({ id: event.id, host_token,
    name: name ?? event.name, date: date ?? event.date,
    time: time ?? event.time, location: location ?? event.location,
    description: description ?? event.description });

  const updated = getFullEvent(event.id);
  broadcastEvent(event.id, { type: 'event_updated', event: updated });
  res.json(updated);
});

// POST /api/events/:id/guests — host adds a guest after creation
app.post('/api/events/:id/guests', (req, res) => {
  const event = q.getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const { host_token, name, phone } = req.body;
  if (!host_token || host_token !== event.host_token)
    return res.status(403).json({ error: 'Unauthorized.' });
  if (!name || !phone)
    return res.status(400).json({ error: 'Name and phone are required.' });

  const guestToken = uuidv4();
  q.insertGuest({
    id: uuidv4(), event_id: event.id, guest_token: guestToken,
    name: name.trim(), phone: phone.trim(),
    rsvp: 'pending', headcount: 1, dish: '', dish_category: '',
  });

  const newGuest  = q.getGuestByToken(guestToken);
  const fullEvent = getFullEvent(event.id);
  broadcastEvent(event.id, { type: 'guest_updated', guests: fullEvent.guests });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  setImmediate(() => notifyGuestsOnCreate(event, [newGuest], baseUrl));

  res.status(201).json({ guest: newGuest, guests: fullEvent.guests });
});

// POST /api/guests/:token/rsvp — guest RSVPs
app.post('/api/guests/:token/rsvp', (req, res) => {
  const guest = q.getGuestByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: 'Guest not found.' });

  const { rsvp, headcount } = req.body;
  if (!['yes', 'no'].includes(rsvp))
    return res.status(400).json({ error: 'rsvp must be "yes" or "no".' });

  q.updateGuestRSVP({ guest_token: guest.guest_token, rsvp,
    headcount: Math.max(1, parseInt(headcount) || 1) });

  const updatedGuest = q.getGuestByToken(guest.guest_token);
  const event        = q.getEventById(guest.event_id);
  setImmediate(() => notifyHostOnRSVP(event, updatedGuest));

  const fullEvent = getFullEvent(guest.event_id);
  broadcastEvent(guest.event_id, { type: 'guest_updated', guests: fullEvent.guests });
  res.json(updatedGuest);
});

// POST /api/guests/:token/dish — guest updates free-text dish
app.post('/api/guests/:token/dish', (req, res) => {
  const guest = q.getGuestByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: 'Guest not found.' });

  const { dish, dish_category } = req.body;
  q.updateGuestDish({ guest_token: guest.guest_token, dish: dish || '', dish_category: dish_category || '' });

  const updatedGuest = q.getGuestByToken(guest.guest_token);
  const event        = q.getEventById(guest.event_id);
  if (dish) setImmediate(() => notifyHostOnDishUpdate(event, updatedGuest));

  const fullEvent = getFullEvent(guest.event_id);
  broadcastEvent(guest.event_id, { type: 'guest_updated', guests: fullEvent.guests });
  res.json(updatedGuest);
});

// GET /api/guests/:token — get single guest by token
app.get('/api/guests/:token', (req, res) => {
  const guest = q.getGuestByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: 'Guest not found.' });
  res.json(guest);
});

// ── Dish Slot Routes ──────────────────────────────────────────────────────────

// POST /api/events/:id/dish-slots — host adds a dish slot
app.post('/api/events/:id/dish-slots', (req, res) => {
  const event = q.getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const { host_token, name, category } = req.body;
  if (!host_token || host_token !== event.host_token)
    return res.status(403).json({ error: 'Unauthorized.' });
  if (!name || !name.trim())
    return res.status(400).json({ error: 'Dish name is required.' });

  q.insertDishSlot({ id: uuidv4(), event_id: event.id, name: name.trim(), category: category || '' });

  const fullEvent = getFullEvent(event.id);
  broadcastEvent(event.id, { type: 'dish_slots_updated', dish_slots: fullEvent.dish_slots });
  res.status(201).json({ dish_slots: fullEvent.dish_slots });
});

// DELETE /api/events/:id/dish-slots/:slotId — host removes a dish slot
app.delete('/api/events/:id/dish-slots/:slotId', (req, res) => {
  const event = q.getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const { host_token } = req.body;
  if (!host_token || host_token !== event.host_token)
    return res.status(403).json({ error: 'Unauthorized.' });

  q.deleteDishSlot(req.params.slotId);

  const fullEvent = getFullEvent(event.id);
  broadcastEvent(event.id, { type: 'dish_slots_updated', dish_slots: fullEvent.dish_slots });
  res.json({ dish_slots: fullEvent.dish_slots });
});

// POST /api/dish-slots/:slotId/claim — guest or host claims a dish slot
app.post('/api/dish-slots/:slotId/claim', (req, res) => {
  const slot = q.getDishSlotById(req.params.slotId);
  if (!slot) return res.status(404).json({ error: 'Dish slot not found.' });
  if (slot.claimed_by_guest_token)
    return res.status(409).json({ error: 'This dish is already claimed.' });

  const { guest_token, host_token, name } = req.body;
  let claimerName, claimerToken;

  if (guest_token) {
    const guest = q.getGuestByToken(guest_token);
    if (!guest || guest.event_id !== slot.event_id)
      return res.status(403).json({ error: 'Invalid guest token.' });
    claimerName  = guest.name;
    claimerToken = guest_token;
  } else if (host_token) {
    const event = q.getEventById(slot.event_id);
    if (!event || event.host_token !== host_token)
      return res.status(403).json({ error: 'Invalid host token.' });
    claimerName  = name || event.host_name;
    claimerToken = `host:${host_token}`;
  } else {
    return res.status(400).json({ error: 'guest_token or host_token required.' });
  }

  q.claimDishSlot({ id: slot.id, guest_token: claimerToken, claimed_by_name: claimerName });

  const fullEvent = getFullEvent(slot.event_id);
  broadcastEvent(slot.event_id, { type: 'dish_slots_updated', dish_slots: fullEvent.dish_slots });
  res.json({ dish_slots: fullEvent.dish_slots });
});

// DELETE /api/dish-slots/:slotId/claim — unclaim a dish slot
app.delete('/api/dish-slots/:slotId/claim', (req, res) => {
  const slot = q.getDishSlotById(req.params.slotId);
  if (!slot) return res.status(404).json({ error: 'Dish slot not found.' });

  const { guest_token, host_token } = req.body;
  const claimerToken = guest_token || `host:${host_token}`;

  // The original claimer OR the host can unclaim
  if (slot.claimed_by_guest_token !== claimerToken) {
    const event = q.getEventById(slot.event_id);
    if (!event || event.host_token !== host_token)
      return res.status(403).json({ error: 'You did not claim this dish.' });
  }

  q.unclaimDishSlot(slot.id);

  const fullEvent = getFullEvent(slot.event_id);
  broadcastEvent(slot.event_id, { type: 'dish_slots_updated', dish_slots: fullEvent.dish_slots });
  res.json({ dish_slots: fullEvent.dish_slots });
});

// ── Join Route — find-or-create guest by name ────────────────────────────────
// POST /api/events/:id/join  { name, phone? }
app.post('/api/events/:id/join', (req, res) => {
  const event = q.getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const { name, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });

  const trimmedName = name.trim();

  // Look for existing guest with same name (case-insensitive)
  const existing = q.getGuestsByEvent(event.id)
    .find(g => g.name.toLowerCase() === trimmedName.toLowerCase());

  if (existing) {
    // Update phone if provided and not already set
    if (phone && phone.trim() && !existing.phone) {
      q.updateGuestPhone({ guest_token: existing.guest_token, phone: phone.trim() });
    }
    return res.json({ guest_token: existing.guest_token, isNew: false });
  }

  // Create new guest
  const guestToken = uuidv4();
  q.insertGuest({
    id: uuidv4(), event_id: event.id, guest_token: guestToken,
    name: trimmedName, phone: (phone || '').trim(),
    rsvp: 'pending', headcount: 1, dish: '', dish_category: '',
  });

  const fullEvent = getFullEvent(event.id);
  broadcastEvent(event.id, { type: 'guest_updated', guests: fullEvent.guests });

  res.status(201).json({ guest_token: guestToken, isNew: true });
});

// ── SPA Fallback ──────────────────────────────────────────────────────────────
app.get('/event/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'event.html'));
});

app.get('/join/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\x1b[32m%s\x1b[0m', `\n🍽️  Plan The Potluck running at http://localhost:${PORT}\n`);
});
