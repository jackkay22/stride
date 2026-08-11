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
| Strava/Whoop sync | Yes | No — later, separately-scoped work |

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

## What's here

| File | What it does |
| --- | --- |
| `index.html` | Sign in / sign up, and (once signed in) a dashboard: race summary + the plan, with hit/niggle/miss buttons per session. |
| `generate-plan.html` | Guided form → builds the copy-pasteable prompt for your own Claude conversation. |
| `upload.html` | Paste or upload the plan JSON Claude produces; validates it and imports it. |
| `reset-password.html` | Handles the "forgot password" email link. |
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

### 2. Get your Supabase anon key (~1 min)

Supabase → **Project Settings → API** → copy the **Project URL** and the **`anon` `public`**
key (not the `service_role` one — this app deliberately never uses that one). You'll paste
both into `config.js` in step 4.

### 3. Deploy the backend as its own Render service (~5 min)

Render → **New → Web Service** → connect this same repo.

- **Root Directory:** `self-service`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** `SUPABASE_URL` and `SUPABASE_ANON_KEY` from step 2 (copy
  `.env.example` for the exact names)

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

### Checking it works

Open that URL, create an account, and try the full loop: **Generate plan** → copy the prompt
into a fresh claude.ai conversation → paste the JSON it gives you into **Upload plan**. If the
format's wrong you'll get a specific list of what to fix rather than a generic failure.

**First request of the day may be slow** — same as the personal app, Render's free tier sleeps
an idle service after ~15 minutes and takes 30–60 seconds to wake back up.

## What friends can and can't do

**Can:** sign up, generate a plan via their own Claude conversation, upload it, see their own
plan, mark sessions hit/niggle/miss, replace their plan with a new upload, reset a forgotten
password.

**Can't:** see anyone else's plan or progress (enforced by the database, not just the UI),
connect Strava/Whoop (not built yet — later, separately-scoped work), or generate a plan
in-app without their own Claude conversation (also deliberately not built — see the top-level
task notes on why).

## Local testing (optional, before deploying)

```
cd self-service
npm install
cp .env.example .env   # fill in real values
npm start
```

Then visit `http://localhost:3001` — should say "Stride self-service backend is running."

Run the validator tests with `npm test` (14 tests, pure logic, no network).
