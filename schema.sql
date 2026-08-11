-- Splits backend schema — run this in Supabase's SQL editor once your project is created.
-- Single-user app: no auth/multi-tenancy complexity needed, but tables are structured
-- so it wouldn't be painful to add later.

create table if not exists sessions_log (
  id uuid primary key default gen_random_uuid(),
  week int not null,
  day text not null,               -- 'Mon'..'Sun'
  status text not null,            -- 'hit' | 'niggle' | 'miss'
  logged_at timestamptz not null default now()
);

create table if not exists vo2_history (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  distance_km numeric not null,
  time_seconds int not null,
  vo2max numeric not null,
  vdot numeric not null,
  created_at timestamptz not null default now()
);

create table if not exists adapt_log (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists whoop_recovery (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null unique,
  recovery_pct numeric,
  resting_hr numeric,
  hrv numeric,
  source text not null default 'manual',  -- 'manual' | 'api'
  created_at timestamptz not null default now()
);

create table if not exists strava_activities (
  id uuid primary key default gen_random_uuid(),
  strava_id bigint unique,               -- null for manually-entered rows
  activity_date date not null,
  distance_km numeric not null,
  pace text,
  avg_hr numeric,
  title text,
  source text not null default 'manual', -- 'manual' | 'api'
  created_at timestamptz not null default now()
);

-- Stores the OAuth tokens for live sync. One row each, single-user app.
create table if not exists integrations (
  provider text primary key,             -- 'strava' | 'whoop'
  access_token text,
  refresh_token text,
  expires_at timestamptz
);

-- The training plan itself. Previously this only existed hardcoded in index.html,
-- which meant there was nothing server-side to write to. Seed it with seed_plan.sql.
create table if not exists plan_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,            -- where the session sits NOW (a reschedule moves this)
  orig_date date not null,               -- where the plan originally put it — never changes
  week int not null,                     -- original slot. stable id, stays put across reschedules
  day text not null,                     -- 'Mon'..'Sun' — original slot, same
  session_type text not null,            -- 'easy'|'long'|'quality'|'strength'|'bike'|'rest'|'event'
  title text not null,
  targets text,
  detail text,
  exercises jsonb,
  phase text not null,                   -- 'rebuild'|'cutback'|'build'|'peak'|'taper'
  week_km text,
  week_headline text,
  status text,                           -- null (not logged yet) | 'hit' | 'niggle' | 'miss'
  notes text,
  status_updated_at timestamptz,
  moved_at timestamptz,                  -- set when session_date has been changed
  updated_at timestamptz not null default now(),
  unique (week, day)
);

create index if not exists plan_sessions_session_date_idx on plan_sessions (session_date);

-- Every write goes in here, so anything can be traced and reversed.
create table if not exists change_log (
  id uuid primary key default gen_random_uuid(),
  changed_at timestamptz not null default now(),
  action text not null,                  -- 'update_session' | 'reschedule_session'
  session_id uuid,
  summary text not null,                 -- plain-English one-liner
  before_state jsonb,                    -- the fields that changed, as they were
  after_state jsonb,                     -- the same fields, as they now are
  source text not null default 'claude', -- 'claude' | 'app'
  override boolean not null default false, -- true if a flagged move was confirmed through
  warnings text
);

create index if not exists change_log_changed_at_idx on change_log (changed_at desc);

-- sessions_log predates plan_sessions and the app still writes to it.
-- These columns keep the two in step without breaking anything already there.
alter table sessions_log add column if not exists notes text;
alter table sessions_log add column if not exists session_date date;
alter table sessions_log add column if not exists source text not null default 'app';
