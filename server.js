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
// Map of eventId → Set of SSE response objects
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

  // Send initial heartbeat
  res.write(': connected\n\n');

  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id).add(res);

  // Heartbeat every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(id)?.delete(res);
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/events — create new event
app.post('/api/events', (req, res) => {
  const { name, date, time, location, description, host_name, host_phone, guests } = req.body;

  if (!name || !date || !time || !location || !host_name || !host_phone) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const eventId = uuidv4();
  const hostToken = uuidv4();

  const eventData = {
    id: eventId,
    host_token: hostToken,
    name,
    date,
    time,
    location,
    description: description || '',
    host_name,
    host_phone,
  };

  const guestList = (guests || []).filter(g => g.name && g.phone);

  const fullEvent = createEventWithGuests(eventData, guestList);

  // Fire invite texts (async — don't block response)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  setImmediate(() => notifyGuestsOnCreate(fullEvent, fullEvent.guests, baseUrl));

  res.status(201).json({
    eventId,
    hostToken,
    eventUrl: `${baseUrl}/event/${eventId}`,
    hostUrl: `${baseUrl}/event/${eventId}?h=${hostToken}`,
  });
});

// GET /api/events/:id — fetch full event (public data)
app.get('/api/events/:id', (req, res) => {
  const event = getFullEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Strip sensitive host_token from public response unless host is requesting
  const { host_token: _ht, ...publicEvent } = event;
  const isHost = req.query.h && req.query.h === event.host_token;

  res.json({ ...publicEvent, isHost });
});

// PATCH /api/events/:id — host edits event details
app.patch('/api/events/:id', (req, res) => {
  const event = q.getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const { host_token, name, date, time, location, description } = req.body;
  if (!host_token || host_token !== event.host_token) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }

  q.updateEvent({
    id: event.id,
    host_token,
    name: name ?? event.name,
    date: date ?? event.date,
    time: time ?? event.time,
    location: location ?? event.location,
    description: description ?? event.description,
  });

  const updated = getFullEvent(event.id);
  broadcastEvent(event.id, { type: 'event_updated', event: updated });
  res.json(updated);
});

// POST /api/guests/:token/rsvp — guest RSVPs
app.post('/api/guests/:token/rsvp', (req, res) => {
  const guest = q.getGuestByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: 'Guest not found.' });

  const { rsvp, headcount } = req.body;
  if (!['yes', 'no'].includes(rsvp)) {
    return res.status(400).json({ error: 'rsvp must be "yes" or "no".' });
  }

  q.updateGuestRSVP({
    guest_token: guest.guest_token,
    rsvp,
    headcount: Math.max(1, parseInt(headcount) || 1),
  });

  const updatedGuest = q.getGuestByToken(guest.guest_token);
  const event = q.getEventById(guest.event_id);

  // Notify host
  setImmediate(() => notifyHostOnRSVP(event, updatedGuest));

  // Broadcast to all connected clients
  const fullEvent = getFullEvent(guest.event_id);
  broadcastEvent(guest.event_id, { type: 'guest_updated', guests: fullEvent.guests });

  res.json(updatedGuest);
});

// POST /api/guests/:token/dish — guest updates dish
app.post('/api/guests/:token/dish', (req, res) => {
  const guest = q.getGuestByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: 'Guest not found.' });

  const { dish, dish_category } = req.body;

  q.updateGuestDish({
    guest_token: guest.guest_token,
    dish: dish || '',
    dish_category: dish_category || '',
  });

  const updatedGuest = q.getGuestByToken(guest.guest_token);
  const event = q.getEventById(guest.event_id);

  // Notify host if dish was set
  if (dish) setImmediate(() => notifyHostOnDishUpdate(event, updatedGuest));

  // Broadcast
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

// ── SPA Fallback ──────────────────────────────────────────────────────────────
app.get('/event/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'event.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\x1b[32m%s\x1b[0m', `\n🍽️  Plan The Potluck running at http://localhost:${PORT}\n`);
});
