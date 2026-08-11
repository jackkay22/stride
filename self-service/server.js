/* ============================================================
   STRIDE SELF-SERVICE BACKEND
   A separate Express app/deployment from ../server.js, on purpose — see
   README.md for the full reasoning. Short version: Jack's personal backend
   stays untouched and unauthenticated (as it always was); this one is a
   small multi-user API that every route requires sign-in for.

   Security model: this file never uses a Supabase service-role key. Every
   request builds a Supabase client authenticated as the calling user (their
   token, forwarded from the frontend after they sign in), so every query
   is subject to the su_* tables' Row Level Security policies (schema.sql).
   A bug in a route here — a missing filter, a copy-paste mistake — cannot
   expose another user's data, because Postgres itself is what's enforcing
   the boundary, not this code.
   ============================================================ */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { validatePlan, VALID_SESSION_TYPES } from './plan-schema.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' })); // a full plan's JSON is small, but generous headroom

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 3001;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set — see .env.example.');
}

/* ============================================================
   AUTH — every /api route below requires a Supabase session token, which
   the frontend attaches after the user signs in via supabase-js. See
   app.js's apiFetch().
   ============================================================ */
function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'Sign in required.' });

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  client.auth.getUser(token).then(({ data, error }) => {
    if (error || !data?.user) return res.status(401).json({ error: 'Your session has expired — sign in again.' });
    req.supabase = client;
    req.user = data.user;
    next();
  }).catch((err) => res.status(500).json({ error: err.message }));
}

// Wraps an async route handler so a thrown/rejected error always comes back
// as a clean JSON error, instead of Express's default HTML error page —
// which breaks the frontend's res.json() parsing and shows a generic
// "Request failed (500)" with no way to tell what actually went wrong.
function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({ error: `Something went wrong on the server: ${err.message}` });
      }
    });
  };
}

const publicShape = (s) => ({
  date: s.session_date,
  week: s.week,
  day: s.day,
  type: s.session_type,
  title: s.title,
  targets: s.targets,
  detail: s.detail,
  exercises: s.exercises || null,
  phase: s.phase,
  week_headline: s.week_headline,
  week_km: s.week_km,
  status: s.status,
  notes: s.notes,
  moved: s.session_date !== s.orig_date ? { from: s.orig_date } : null,
});

async function recordChange(supabase, userId, entry) {
  const { error } = await supabase.from('su_change_log').insert({ user_id: userId, ...entry });
  if (error) return `Saved, but logging the change failed: ${error.message}`;
  return null;
}

/* ============================================================
   PROFILE — race details captured from the plan's meta block
   ============================================================ */
app.get('/api/profile', requireUser, asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase
    .from('su_profiles')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

/* ============================================================
   PLAN — read
   ============================================================ */
app.get('/api/plan', requireUser, asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase
    .from('su_plan_sessions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('session_date')
    .order('session_type');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(publicShape));
}));

/* ============================================================
   PLAN — upload (validate + replace)
   Same validation the guided flow's prompt template is written to satisfy —
   see plan-schema.js. This is the self-service equivalent of the manual
   upload function: same checks, but callable directly by the signed-in
   user instead of only by Jack via backend access.
   ============================================================ */
app.post('/api/plan/upload', requireUser, asyncRoute(async (req, res) => {
  const result = validatePlan(req.body);
  if (!result.ok) {
    return res.status(400).json({
      error: "This file doesn't match the format Stride expects.",
      details: result.errors,
    });
  }

  const { meta, sessions } = result.plan;
  const userId = req.user.id;

  const { count: existingCount } = await req.supabase
    .from('su_plan_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  // Replace-whole-plan semantics: this is an import, not a merge. The
  // upload page warns the user before this runs if they already have a plan.
  const { error: delErr } = await req.supabase.from('su_plan_sessions').delete().eq('user_id', userId);
  if (delErr) return res.status(500).json({ error: `Could not clear your previous plan: ${delErr.message}` });

  const rows = sessions.map((s) => ({ ...s, user_id: userId }));
  const { error: insErr } = await req.supabase.from('su_plan_sessions').insert(rows);
  if (insErr) return res.status(500).json({ error: `Could not save your plan: ${insErr.message}` });

  const { error: profErr } = await req.supabase.from('su_profiles').upsert({
    user_id: userId,
    race_name: meta.race_name,
    race_date: meta.race_date,
    target_time: meta.target_time,
    block_start: meta.block_start,
    total_weeks: meta.total_weeks,
    updated_at: new Date().toISOString(),
  });
  if (profErr) {
    return res.status(500).json({ error: `Your plan saved, but your profile details failed to save: ${profErr.message}` });
  }

  const summary = (existingCount ?? 0) > 0
    ? `Replaced existing plan (${existingCount} sessions) with a new upload — ${rows.length} sessions, ${meta.race_name || 'race'} on ${meta.race_date}.`
    : `Imported first plan — ${rows.length} sessions, ${meta.race_name || 'race'} on ${meta.race_date}.`;

  const logWarning = await recordChange(req.supabase, userId, {
    action: 'upload_plan',
    summary,
    after_state: { sessions: rows.length, ...meta },
    source: 'app',
  });

  res.json({ ok: true, summary, sessions_imported: rows.length, meta, ...(logWarning ? { log_warning: logWarning } : {}) });
}));

/* ============================================================
   SESSIONS — log hit/niggle/miss against a session already in the plan
   ============================================================ */
app.post('/api/sessions', requireUser, asyncRoute(async (req, res) => {
  const { week, day, status, notes } = req.body;
  const userId = req.user.id;

  if (!Number.isInteger(week) || !day || !status) {
    return res.status(400).json({ error: 'week, day, status are required.' });
  }
  if (!['hit', 'niggle', 'miss'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of: hit, niggle, miss.' });
  }

  const { data: session, error: findErr } = await req.supabase
    .from('su_plan_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('week', week)
    .eq('day', day)
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!session) return res.status(404).json({ error: `No session found for week ${week} ${day}.` });

  const before = { status: session.status, notes: session.notes };

  const { data: updated, error: updErr } = await req.supabase
    .from('su_plan_sessions')
    .update({
      status,
      notes: notes ?? session.notes,
      status_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.id)
    .select()
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  const { error: logErr } = await req.supabase.from('su_sessions_log').insert({
    user_id: userId,
    week,
    day,
    status,
    notes: notes ?? null,
    session_date: session.session_date,
    source: 'app',
  });
  if (logErr) return res.status(500).json({ error: logErr.message });

  const summary = `Week ${week} ${day} (${session.title}) marked ${status}` + (notes ? ` — "${notes}"` : '');
  const logWarning = await recordChange(req.supabase, userId, {
    action: 'update_session',
    session_id: session.id,
    summary,
    before_state: before,
    after_state: { status, notes: notes ?? session.notes },
    source: 'app',
  });

  res.json({ ok: true, summary, session: publicShape(updated), ...(logWarning ? { log_warning: logWarning } : {}) });
}));

/* ============================================================
   CHANGE LOG
   ============================================================ */
app.get('/api/change-log', requireUser, asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase
    .from('su_change_log')
    .select('*')
    .eq('user_id', req.user.id)
    .order('changed_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.get('/api/meta', (_req, res) => res.json({ valid_session_types: VALID_SESSION_TYPES }));

app.get('/', (_req, res) => res.send('Stride self-service backend is running.'));

// Catches anything asyncRoute() can't — e.g. express.json() rejecting a
// malformed request body, which calls next(err) directly rather than
// throwing inside a route handler. Without this, that class of error still
// fell through to Express's default HTML error page. Must be registered
// after every route (Express identifies error handlers by their 4 arguments,
// but by convention they go last).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(400).json({ error: `Couldn't read that request: ${err.message}` });
});

app.listen(PORT, () => console.log(`Stride self-service backend listening on ${PORT}`));
