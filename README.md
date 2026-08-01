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

## What I'll do once this is live
Once you've got a live URL, I'll wire the frontend (the Splits app) up to call it
instead of using local-only state — that turns it from a demo into the real thing.

## Local testing (optional, before deploying)
```
npm install
cp .env.example .env   # fill in your real values
npm start
```
Then visit `http://localhost:3000` — should say "Splits backend is running."
