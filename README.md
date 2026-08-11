# Splits backend

Real backend for the Splits marathon training app: stores your plan progress,
VO2 history, and syncs Whoop + Strava data so nothing resets when you close a tab.

Everything below uses free tiers — this shouldn't cost you anything for personal use.

## What you need to do (the parts only you can do)

### 1. Create a Supabase project (~3 min)
- Go to supabase.com → New project (free tier)
- Once it's created, go to the SQL editor and paste in the contents of `schema.sql`, then run it
- Go to Project Settings → API and copy the **Project URL** and **service_role key**
  into your `.env` as `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`

### 2. Register a Strava API app (~3 min)
- Go to strava.com/settings/api
- Create an app — for "Authorization Callback Domain" use whatever domain you deploy to
  (e.g. `splits-backend.onrender.com`) — you can use `localhost` while testing
- Copy the **Client ID** and **Client Secret** into `.env`

### 3. Register a Whoop developer app (~3 min)
- Go to developer.whoop.com → create a developer account (needs your existing Whoop membership)
- Create an app, set the redirect URI to `<your deployed URL>/auth/whoop/callback`
- Copy the **Client ID** and **Client Secret** into `.env`

### 4. Deploy it (~5 min)
Easiest free option: **Render** (render.com)
- New → Web Service → connect this folder/repo
- Build command: `npm install`
- Start command: `npm start`
- Add all your `.env` values as environment variables in Render's dashboard
- Once deployed, update `BASE_URL` in Render's env vars to your actual Render URL
  (e.g. `https://splits-backend.onrender.com`) and redeploy

### 5. Connect the accounts
Once it's live, visit these two URLs once each (in your browser, logged into Strava/Whoop):
- `https://<your-backend-url>/auth/strava`
- `https://<your-backend-url>/auth/whoop`

Each will redirect you to approve access, then bounce back and say "connected."
That's it — after that, it auto-syncs both every 3 hours on its own.

### 6. Updating the plan from a conversation with Claude
See **[SETUP.md](SETUP.md)** — generate an API key, run `schema.sql` and `seed_plan.sql`,
add `STRIDE_API_KEY` to Render, then add the connector in Claude's settings.

## How it's put together

| File | What it does |
| --- | --- |
| `index.html` | The app. Static, on GitHub Pages. Reads the plan from the backend, falls back to its own built-in copy if the backend is asleep. |
| `manifest.webmanifest` | Makes the app installable to a home screen (name, icon, full-screen). |
| `sw.js` | Service worker. Caches the app shell only — never the API or `passcode.js`, so the plan can't go stale and a passcode change always takes effect immediately. |
| `icons/` | App icons, generated from the runner mark. |
| `passcode.js` | Holds a SHA-256 fingerprint of the access passcode — never the passcode itself. Edit directly on GitHub to set or change it; see SETUP.md. |
| `passcode-tool.html` | Standalone page that turns a passcode into that fingerprint, entirely client-side. Not linked from the app. |
| `server.js` | Express app: Strava/Whoop sync, VO2, session log, and the plan endpoints. |
| `plan-service.js` | The plan read/write logic and the safety checks. One implementation, used by both the HTTP endpoints and the MCP tools. |
| `mcp-server.js` | Wraps that as MCP tools so Claude can call them mid-conversation. Mounted at `/mcp` on the same service. |
| `schema.sql` | Database tables. Safe to re-run. |
| `seed_plan.sql` | Loads the 12-week plan into `plan_sessions`. Generated from `index.html`. |
| `test/` | `npm test` — 19 tests, run against an in-memory fake, never touch live data. |

### Design

The UI follows the "Stride Weekly Premium" handoff: dark radial background, glass day
rows (translucent fill, 14px backdrop blur, hairline border, soft shadow), Petrona serif
for headline and session-title moments, Manrope for everything else. Status is carried by
a coloured left-edge accent bar plus an icon, not saturated fills — those colours are
intentionally desaturated and shouldn't be brightened.

Two things worth knowing:

- **Session type tags are neutral grey**, per the handoff — the old colour-coded type
  pills were dropped so status is the only thing carrying colour.
- **Past sessions that were never logged show "Not logged", not "Missed"**. The handoff
  has no state for this. Marking them missed would put a status in the log that was
  never actually set.

All dates render UK format — `13/08/2026` in rows, `Thursday, 13 Aug 2026` and
`10–16 Aug 2026` for headlines. ISO dates are still what the API and database use.

### Plan endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/plan?from=&to=` | none | The plan, with statuses and notes |
| `GET /api/change-log` | none | Record of every write |
| `POST /api/plan/update-session` | API key | Mark a session hit/niggle/miss + notes |
| `POST /api/plan/reschedule-session` | API key | Move a session or change its type |
| `POST /mcp` | API key | MCP endpoint for the Claude connector |

`reschedule-session` returns **409** with a list of warnings, and changes nothing, if the
move would shift load between weeks, cross a training phase boundary, or put a hard session
into a cutback or taper week. Re-send with `"confirm": true` to go ahead anyway; that gets
recorded in `change_log` as an override.

The API key goes in an `Authorization: Bearer <key>` header, an `X-API-Key` header, or —
for the Claude connector, which only has a URL field — as the last part of the path:
`/mcp/<key>`.

Note that the app's own endpoints (`/api/sessions`, `/api/vo2`, and the rest) are still
unauthenticated, as they were before. The app is a static page on GitHub Pages, so it has
nowhere safe to keep a key. Only the Claude write endpoints require one.

## Local testing (optional, before deploying)
```
npm install
cp .env.example .env   # fill in your real values
npm start
```
Then visit `http://localhost:3000` — should say "Splits backend is running."

Run the tests with `npm test`.
