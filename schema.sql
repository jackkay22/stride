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
