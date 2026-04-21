# OceanChat

OceanChat is a lightweight random chat app where people can connect as guests or registered users, then chat via text and optional WebRTC audio/video.

## Features implemented

- Guest flow with temp profile and preferences.
- Registered flow with account creation + sign in.
- Password hashing using Node.js `crypto.scrypt`.
- Persistent account storage using SQLite via Prisma (`prisma/oceanchat.db`) so users survive restart.
- Username uniqueness checks.
- Real-time stats (total users, male, female).
- Preference-aware random matching (male/female/any).
- Text chat between matched partners.
- WebRTC signaling for audio/video calls.
- Disconnect handling + reconnect to last partner.
- Browser screenshot utility using Playwright.

## Run locally

```bash
npm install
npm start
```

Then open: http://localhost:3000

### Windows quick start

1. Install Node.js LTS.
2. Open PowerShell in the project folder.
3. Run:

```powershell
npm install
npm start
```

This creates `prisma/oceanchat.db` automatically.
On startup, OceanChat also runs Prisma generation + schema push automatically.

## Screenshot tool

Screenshot support is optional and not required to run OceanChat.

1. Install Playwright + browser binary:

```bash
npm run screenshot:install
```

2. Capture screenshot (defaults shown):

```bash
npm run screenshot -- http://localhost:3000 artifacts/oceanchat-home.png body
```

Arguments:
- arg1: URL (default: `http://localhost:3000`)
- arg2: output image path (default: `artifacts/oceanchat-home.png`)
- arg3: CSS selector to wait for before capture (default: `body`)

## Important production notes

Current code persists **accounts** in SQLite, but active sessions/chats are still in-memory. For production:

1. Add a real database (PostgreSQL/MongoDB).
2. Persist sessions/tokens and introduce proper auth middleware.
3. Add moderation/report/block flow.
4. Add rate limits and abuse prevention.
5. For scale, run Socket.IO with Redis adapter.
6. Use HTTPS and TURN servers for reliable WebRTC connectivity.
