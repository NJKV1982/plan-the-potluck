# Plan The Potluck — How to Run

## Quick Start (your Mac)

```bash
cd plan-the-potluck
npm install        # first time only
node server.js     # starts on http://localhost:3000
```

Open http://localhost:3000 in your browser. That's it.

## What gets created

- `potluck-db.json` — your event data (auto-created on first run, persists across restarts)

## To add real Twilio SMS

1. `npm install twilio`
2. Open `notifications.js` and replace the `mockSend` function:

```js
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function mockSend(to, message) {
  await twilio.messages.create({ body: message, from: process.env.TWILIO_NUMBER, to });
}
```

3. Set env vars: `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_NUMBER`

## About GitHub Pages

GitHub Pages only serves **static files** — it cannot run Node.js or store data.
To deploy this app publicly, use one of these free options instead:

| Service | How |
|---------|-----|
| **Railway** (recommended) | Connect GitHub repo → auto-deploys |
| **Render** | Free tier Node.js web service |
| **Fly.io** | `fly launch` from project folder |
