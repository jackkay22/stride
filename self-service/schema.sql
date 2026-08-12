-- Self-service Stride schema.
--
-- Run this in the SAME Supabase project as the personal app's schema.sql —
-- these are entirely new tables (su_* prefix) and never touch
-- plan_sessions, sessions_log, change_log, etc. Safe to run alongside it.
--
-- Safe to re-run as often as you like: tables and indexes are guarded with
-- "if not exists", and each policy is dropped before being recreated. Postgres
-- has no "create policy if not exists", so without those drops a second run
-- fails with 'policy "..." already exists' — which is exactly what happens
-- when new tables are added here later and the whole file gets run again.
-- Re-running never touches existing rows.
--
-- Multi-user by design: every table carries a user_id referencing Supabase
-- Auth's built-in auth.users, and has Row Level Security switched on with a
-- policy that only ever matches auth.uid() = user_id. That means isolation
-- between two friends' data is enforced by Postgres itself on every query —
-- not something the backend has to remember to filter for. See
-- self-service/server.js for how the backend uses this (it authenticates as
-- the signed-in user for every request, never as an admin/service role).

create table if not exists su_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  race_name text,
  race_date date,
  target_time text,           -- free text, e.g. "3:30:00" — never parsed
  block_start date,           -- Monday of week 1 of the uploaded plan
  total_weeks int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table su_profiles enable row level security;

drop policy if exists "own profile only" on su_profiles;
create policy "own profile only" on su_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Mirrors plan_sessions, per-user. An upload is a full replace: the backend
-- deletes this user's existing rows and inserts the new file's rows in one
-- request — it's an import, not a merge (see self-service/README.md).
create table if not exists su_plan_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_date date not null,
  orig_date date not null,
  week int not null,
  day text not null,               -- 'Mon'..'Sun'
  session_type text not null,      -- 'easy'|'long'|'quality'|'strength'|'bike'|'rest'|'event'
  title text not null,
  targets text,
  detail text,
  exercises jsonb,
  phase text not null,
  week_km text,
  week_headline text,
  status text,                     -- null | 'hit' | 'niggle' | 'miss'
  notes text,
  status_updated_at timestamptz,
  moved_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, week, day)
);

create index if not exists su_plan_sessions_user_date_idx on su_plan_sessions (user_id, session_date);

alter table su_plan_sessions enable row level security;

drop policy if exists "own sessions only" on su_plan_sessions;
create policy "own sessions only" on su_plan_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Mirrors sessions_log, per-user — an append-only record of every
-- hit/niggle/miss, kept for the same reason it exists in the personal schema.
create table if not exists su_sessions_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week int not null,
  day text not null,
  status text not null,
  notes text,
  session_date date,
  source text not null default 'app',
  logged_at timestamptz not null default now()
);

create index if not exists su_sessions_log_user_idx on su_sessions_log (user_id, logged_at desc);

alter table su_sessions_log enable row level security;

drop policy if exists "own session log only" on su_sessions_log;
create policy "own session log only" on su_sessions_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Mirrors change_log, per-user.
create table if not exists su_change_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  changed_at timestamptz not null default now(),
  action text not null,            -- 'upload_plan' | 'update_session'
  session_id uuid,
  summary text not null,
  before_state jsonb,
  after_state jsonb,
  source text not null default 'app'
);

create index if not exists su_change_log_user_idx on su_change_log (user_id, changed_at desc);

alter table su_change_log enable row level security;

drop policy if exists "own change log only" on su_change_log;
create policy "own change log only" on su_change_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

/* ============================================================
   STRAVA — per-user connections.

   The personal app has one row in `integrations` because it has one user.
   Here each person authorises their own Strava account, so tokens are stored
   per-user and protected by the same RLS rule as everything else: a token row
   is only ever readable by the user it belongs to.

   Note there is deliberately no background/cron sync. A scheduled job runs
   with no user present, so it would need the Supabase service-role key —
   the one thing this app is built never to use. Instead the backend syncs a
   user's activities while they're signed in and using the app, with their own
   credentials. See server.js and README.md.
   ============================================================ */

create table if not exists su_integrations (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,                -- 'strava' (whoop later, same shape)
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  athlete_id bigint,                     -- provider's own id for the account
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  primary key (user_id, provider)
);

alter table su_integrations enable row level security;

drop policy if exists "own integrations only" on su_integrations;
create policy "own integrations only" on su_integrations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists su_strava_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  strava_id bigint not null,
  activity_date date not null,
  distance_km numeric not null,
  moving_time_seconds int,
  pace text,
  avg_hr numeric,
  title text,
  activity_type text,
  created_at timestamptz not null default now(),
  unique (user_id, strava_id)
);

create index if not exists su_strava_activities_user_date_idx
  on su_strava_activities (user_id, activity_date desc);

alter table su_strava_activities enable row level security;

drop policy if exists "own activities only" on su_strava_activities;
create policy "own activities only" on su_strava_activities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No table is needed for the OAuth handshake itself. Strava redirects back to
-- a page in this app (strava-callback.html), not to the backend — that page
-- still holds the user's signed-in session, so it can hand the authorisation
-- code to the backend as a normal authenticated request. The backend therefore
-- always knows who it is acting for, and never needs privileged access to look
-- an in-flight handshake up. CSRF is covered by a random `state` value the
-- frontend keeps in sessionStorage and checks on return.
