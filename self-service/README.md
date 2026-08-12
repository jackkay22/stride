# Stride Self-Service

A separate, multi-user version of Stride for friends who want to run their own training block —
each person generates their own plan with their own Claude conversation, then imports it here.
Jack's personal app (`../index.html`, `stride-lrdq.onrender.com`) is untouched by any of this.

## How this relates to the personal app

| | Personal app (`/`) | Self-service (`/self-service`) |
| --- | --- | --- |
| Who | Jack only | Any friend who signs up |
| Plan generation | Manual, via a conversation Jack has with Claude on their behalf (see the parked `stride-plan-upload-brief.md` work) | Each person has their own conversation with Claude, using the [prompt template](generate-plan.html) here — their account, their usage, nothing routed through Jack |
| Auth | None (a client-side passcode gate, not real security) | Supabase Auth — real per-user accounts |
| Data | One 12-week block, hardcoded dates | However many plans, one per account, isolated by database-level row security |
| Strava sync | Yes — Jack's own account, 3-hourly cron | Yes — each person connects their own, synced while they're using the app |
| Whoop sync | Yes | No — later, separately-scoped work |

## Architecture decision — separate deployment (flagging this, per the brief)

I went with **a separate frontend section, a separate backend service, and separate database
tables — but the same GitHub repo and the same Supabase project.** Concretely:

- **Frontend:** this `self-service/` folder, served by GitHub Pages as a sub-path of the
  existing site (`jackkay22.github.io/stride/self-service/`) — not a new repo. GitHub Pages
  already serves the whole repo as static files (see the root `.nojekyll`), so a folder is all
  that's needed; there's nowhere here that requires a second Pages site.
- **Backend:** a second, independent Express app (`self-service/server.js`, own
  `package.json`), meant to be deployed as its **own Render web service**, separate from
  `stride-lrdq`.
- **Database:** the **same Supabase project** Jack already has, but four brand-new tables
  (`su_profiles`, `su_plan_sessions`, `su_sessions_log`, `su_change_log` — see `schema.sql`).
  Nothing here alters or reads `plan_sessions`, `sessions_log`, `change_log`, or any other
  table the personal app uses.

**Why not just add a login gate to the existing app and share its backend?** Because the
personal app and its backend are live and in active use for Jack's real training block right
now — including the MCP connector giving Claude write access to it. Multi-user auth is new
surface area (new failure modes: a bug in a request-scoping check, an auth middleware
regression, extra load on a service that's mid-training-block). Keeping it a separate process
means a bug or an outage in the self-service backend can't touch Jack's tracking, and vice
versa. It also means the two can be reasoned about separately — the personal app's endpoints
stay exactly as unauthenticated as the README already documents them to be, no exceptions
carved in for "except when serving someone else's data."

**Why not a fully separate repo / separate Supabase project too?** That would buy a bit more
isolation but at a real cost for someone who "can't debug code directly": a second GitHub repo
to navigate, a second Supabase account/project to create and remember, twice the places a
setup step could go wrong. Row Level Security (below) gives the same practical isolation
guarantee — a query authenticated as one user structurally cannot touch another user's rows —
without that overhead. One repo, one Supabase login, two small independent things to deploy.

If this grows past "a handful of friends," splitting the repo/Supabase project too would be a
reasonable next step, but isn't needed for this stage.

## How isolation actually works

Every `su_*` table has Row Level Security switched on with a policy of `auth.uid() = user_id`
(see `schema.sql`). The backend (`server.js`) never uses a Supabase **service-role** key —
every request is authenticated as the signed-in user, using the token their browser got from
Supabase Auth at sign-in. That means the database itself refuses any query that isn't scoped
to that user, regardless of what the backend code does or forgets to do. This is a stronger
guarantee than "the backend remembers to add `WHERE user_id = ...` everywhere" — it's enforced
one layer down, in Postgres.

That constraint is why two things are shaped the way they are. Strava's OAuth redirect goes to
a page in this app rather than to the backend, so the request that completes the connection
still carries the user's session. And Strava syncing happens while someone is using the app
rather than on a schedule, because a cron job has no signed-in user to act as. Both are
deliberate trade-offs to avoid ever needing the service-role key.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | Sign in / sign up, and (once signed in) a dashboard: race summary + the plan, with hit/niggle/miss buttons per session. |
| `generate-plan.html` | Guided form → builds the copy-pasteable prompt for your own Claude conversation. |
| `upload.html` | Paste or upload the plan JSON Claude produces; validates it and imports it. |
| `reset-password.html` | Handles the "forgot password" email link. |
| `strava-callback.html` | Where Strava sends people back after they authorise. Hands the code to the backend as an authenticated request — see the Strava note in `server.js` for why the redirect lands here rather than on the backend. |
| `config.js` | The three non-secret values (Supabase URL, Supabase anon key, backend URL) — edit directly on GitHub after deploying, same pattern as `../passcode.js`. |
| `app.js`, `style.css` | Shared Supabase client/auth helpers and look, used by every page above. |
| `plan-schema.js` | The JSON shape an uploaded plan must match, and the validator. Mirrors the columns `../plan_sessions` already uses — see the comment at the top of the file for why it's defined fresh here rather than reused from elsewhere. |
| `server.js` | The backend: auth-gated API for profile, plan, upload, session logging, change log. |
| `schema.sql` | The four new database tables + Row Level Security policies. |
| `test/` | `npm test` — validator tests, no network, never touch a real database. |

## Setup (the parts only Jack can do)

Four things, roughly 20 minutes, no code required. **These all need doing outside Claude Code** —
they're clicks in Supabase, Render, and GitHub's web UI.

### 1. Run the new database tables (~2 min)

Supabase → your existing project → **SQL Editor** → **New query** → paste in the whole of
`self-service/schema.sql` → **Run**. This only adds new tables; it can't affect anything the
personal app uses.

While there, check **Authentication → Providers → Email** is enabled (it is by default on a
new Supabase project). Optionally, if you'd rather friends could use the app immediately
without confirming their email first, toggle off **"Confirm email"** on that same page — not
required, just fewer steps for them.

### 1b. Allow the app's URLs for email links (~2 min) — easy to miss

Supabase → **Authentication → URL Configuration**:

- **Site URL:** `https://jackkay22.github.io/stride/self-service/`
- **Redirect URLs:** add `https://jackkay22.github.io/stride/self-service/**`

Without this, Supabase refuses to send people back to the app after a password reset or an
email confirmation — it silently falls back to its own default URL, so the link in the email
lands somewhere that isn't this app and the reset appears broken for no visible reason.

### 2. Get your Supabase publishable key (~1 min)

Supabase → **Project Settings → API** → copy the **Project URL** and the **Publishable key**
(`sb_publishable_...`).

**Not the Secret key** (`sb_secret_...`) — that one grants full admin access and this app
deliberately never uses it. Supabase renamed these recently: what older docs and this repo's
code call the "anon key" is what the dashboard now labels **Publishable**, and the old
"service_role key" is now **Secret**. GitHub also actively blocks committing a Secret key, so
if a commit gets rejected for containing a secret, that's the wrong key.

You'll paste both of these into `config.js` in step 4, and into Render in step 3.

### 3. Deploy the backend as its own Render service (~5 min)

Render → **New → Web Service** → connect this same repo. This must be a **new, separate
service** from the personal app's `stride` service, not a change to that one.

- **Root Directory:** `self-service`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** exactly two —

  | Name | Value |
  | --- | --- |
  | `SUPABASE_URL` | Project URL from step 2 |
  | `SUPABASE_ANON_KEY` | Publishable key from step 2 |

> **The names have to match exactly.** The code looks up `SUPABASE_ANON_KEY` specifically —
> the personal app uses a different name (`SUPABASE_SERVICE_KEY`) for a different key, and
> setting that name here means this app finds nothing and every request fails with
> "Invalid supabaseUrl" or similar. Don't reuse or link the personal app's variables here;
> give this service its own two.

Once it's deployed, note the URL Render gives it (something like
`https://stride-self-service.onrender.com`) — you'll need it in the next step.

### 4. Fill in `config.js` (~2 min)

Go to `github.com/jackkay22/stride/blob/main/self-service/config.js`, click the pencil to edit,
and fill in the three values from steps 2–3:

```js
window.STRIDE_SS_CONFIG = {
  SUPABASE_URL: '...',       // from step 2
  SUPABASE_ANON_KEY: '...',  // from step 2
  BACKEND_URL: '...',        // from step 3
};
```

Commit. A minute or two later, `https://jackkay22.github.io/stride/self-service/` is live.

### 5. Optional: let people connect their own Strava (~5 min)

Skip this and everything else still works — the Strava section stays hidden until the two
variables below are set, so nobody sees a button that can't do anything.

This needs its **own Strava API app**, separate from the personal app's. Strava allows one
callback domain per app, and the personal app's is already pointed at its own Render service.
Same Strava account, second app:

1. Go to <https://www.strava.com/settings/api> → create a new app
2. **Authorization Callback Domain:** `jackkay22.github.io`
   (just the domain — no `https://`, no path. The redirect lands on the app's own
   `strava-callback.html` page, not on the backend, so this is the right domain.)
3. Copy the **Client ID** and **Client Secret**
4. Render → your self-service service → **Environment** → add:

   | Name | Value |
   | --- | --- |
   | `STRAVA_CLIENT_ID` | from step 3 |
   | `STRAVA_CLIENT_SECRET` | from step 3 |

5. Save — Render redeploys, and a **Connect Strava** panel appears on everyone's plan page

Each person connects their own Strava account. Nobody's runs are visible to anyone else, and
none of it touches the personal app's Strava connection.

**Note on how syncing works:** runs are pulled in while someone is signed in and using the app
— when they open it, and whenever they press **Sync now** — rather than on a background
schedule. The personal app can sync on a 3-hour cron because it has one known user; a
scheduled job here would have no signed-in user, so it would need Supabase's service-role key,
which this app is deliberately built never to use. The practical difference: if someone doesn't
open the app for a week, their runs appear the moment they next do.

### Checking it works

Open that URL, create an account, and try the full loop: **Generate plan** → copy the prompt
into a fresh claude.ai conversation → paste the JSON it gives you into **Upload plan**. If the
format's wrong you'll get a specific list of what to fix rather than a generic failure.

**First request of the day may be slow** — same as the personal app, Render's free tier sleeps
an idle service after ~15 minutes and takes 30–60 seconds to wake back up.

## What friends can and can't do

**Can:** sign up, generate a plan via their own Claude conversation, upload it, see their own
plan, mark sessions hit/niggle/miss, replace their plan with a new upload, reset a forgotten
password, and — once step 5 is done — connect their own Strava account and see their recent
runs alongside the plan.

**Can't:** see anyone else's plan, progress, or runs (enforced by the database, not just the
UI), connect Whoop (not built yet — later, separately-scoped work), or generate a plan in-app
without their own Claude conversation (also deliberately not built — see the top-level task
notes on why).

## Local testing (optional, before deploying)

```
cd self-service
npm install
cp .env.example .env   # fill in real values
npm start
```

Then visit `http://localhost:3001` — should say "Stride self-service backend is running."

Run the validator tests with `npm test` (14 tests, pure logic, no network).
