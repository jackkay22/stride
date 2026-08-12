
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { createMcpRouter } from './mcp-server.js';
import { getPlan, getChangeLog, updateSession, rescheduleSession, applyQuickAction, PlanError } from './plan-service.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.STRIDE_API_KEY;
 
/* ============================================================
   SESSIONS LOG — hit/niggle/miss per planned session
   ============================================================ */
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase.from('sessions_log').select('*').order('logged_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
app.post('/api/sessions', async (req, res) => {
  const { week, day, status, notes } = req.body;
  if (!week || !day || !status) return res.status(400).json({ error: 'week, day, status are required' });
  const { data, error } = await supabase.from('sessions_log').insert({ week, day, status, notes: notes ?? null, source: 'app' }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Mirror onto plan_sessions so the app and Claude see the same statuses.
  // week/day here are the original plan slot, which is what plan_sessions keys on.
  await supabase
    .from('plan_sessions')
    .update({
      status,
      ...(notes !== undefined ? { notes } : {}),
      status_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('week', week)
    .eq('day', day);

  // simple adaptive rule engine — mirrors the logic from the standalone prototype
  let adaptMsg = null;
  if (status === 'miss') {
    if (day === 'Sun') adaptMsg = `Missed the Week ${week} long run — moved to Monday, distance kept the same.`;
    else if (day === 'Tue') adaptMsg = `Missed Week ${week}'s quality session — dropped, no reschedule.`;
    else adaptMsg = `Missed Week ${week}'s ${day} session — dropped.`;
  } else if (status === 'niggle') {
    adaptMsg = `Niggle flagged Week ${week} ${day} — next quality session swapped for easy, strength pushed back 48h.`;
  }
  if (adaptMsg) await supabase.from('adapt_log').insert({ message: adaptMsg });
 
  res.json({ session: data, adaptation: adaptMsg });
});
 
/* ============================================================
   ADAPT LOG
   ============================================================ */
app.get('/api/adapt-log', async (req, res) => {
  const { data, error } = await supabase.from('adapt_log').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
/* ============================================================
   VO2 MAX / VDOT
   ============================================================ */
function estimateVO2(distanceKm, seconds) {
  const minutes = seconds / 60;
  const velocity = (distanceKm * 1000) / minutes;
  const vo2 = -4.6 + 0.182258 * velocity + 0.000104 * velocity * velocity;
  const pctMax = 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
  return vo2 / pctMax;
}
 
app.get('/api/vo2', async (req, res) => {
  const { data, error } = await supabase.from('vo2_history').select('*').order('entry_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
app.post('/api/vo2', async (req, res) => {
  const { entry_date, distance_km, time_seconds } = req.body;
  if (!distance_km || !time_seconds) return res.status(400).json({ error: 'distance_km and time_seconds required' });
  const vdot = estimateVO2(distance_km, time_seconds);
  const { data, error } = await supabase
    .from('vo2_history')
    .insert({ entry_date: entry_date || new Date().toISOString().slice(0, 10), distance_km, time_seconds, vo2max: vdot, vdot })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
/* ============================================================
   WHOOP — manual entry + OAuth + sync
   ============================================================ */
app.post('/api/whoop/manual', async (req, res) => {
  const { entry_date, recovery_pct, resting_hr, hrv } = req.body;
  const { data, error } = await supabase
    .from('whoop_recovery')
    .upsert({ entry_date, recovery_pct, resting_hr, hrv, source: 'manual' }, { onConflict: 'entry_date' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
app.get('/api/whoop', async (req, res) => {
  const { data, error } = await supabase.from('whoop_recovery').select('*').order('entry_date', { ascending: false }).limit(60);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
// Step 1: send Jack here to approve access
app.get('/auth/whoop', (req, res) => {
  const url = `https://api.prod.whoop.com/oauth/oauth2/auth?response_type=code&client_id=${process.env.WHOOP_CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE_URL + '/auth/whoop/callback')}&scope=read:recovery read:cycles read:sleep offline`;
  res.redirect(url);
});
 
// Step 2: Whoop redirects back here with a code — exchange it for tokens
app.get('/auth/whoop/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.WHOOP_CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/whoop/callback`
      })
    });
    const tokens = await tokenRes.json();
    await supabase.from('integrations').upsert({
      provider: 'whoop',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000)
    });
    res.send('Whoop connected — you can close this tab.');
  } catch (err) {
    res.status(500).send('Whoop auth failed: ' + err.message);
  }
});
 
async function syncWhoop() {
  const { data: integ } = await supabase.from('integrations').select('*').eq('provider', 'whoop').single();
  if (!integ) return;
  const recRes = await fetch('https://api.prod.whoop.com/developer/v1/recovery?limit=10', {
    headers: { Authorization: `Bearer ${integ.access_token}` }
  });
  const recData = await recRes.json();
  for (const rec of recData.records || []) {
    await supabase.from('whoop_recovery').upsert(
      {
        entry_date: rec.created_at.slice(0, 10),
        recovery_pct: rec.score?.recovery_score,
        resting_hr: rec.score?.resting_heart_rate,
        hrv: rec.score?.hrv_rmssd_milli,
        source: 'api'
      },
      { onConflict: 'entry_date' }
    );
  }
}
 
/* ============================================================
   STRAVA — manual entry + OAuth + sync
   ============================================================ */
app.post('/api/strava/manual', async (req, res) => {
  const { activity_date, distance_km, pace, avg_hr, title } = req.body;
  const { data, error } = await supabase
    .from('strava_activities')
    .insert({ activity_date, distance_km, pace, avg_hr, title, source: 'manual' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
app.get('/api/strava', async (req, res) => {
  const { data, error } = await supabase.from('strava_activities').select('*').order('activity_date', { ascending: false }).limit(60);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
app.get('/auth/strava', (req, res) => {
  const url = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(BASE_URL + '/auth/strava/callback')}&approval_prompt=auto&scope=activity:read_all`;
  res.redirect(url);
});
 
app.get('/auth/strava/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    await supabase.from('integrations').upsert({
      provider: 'strava',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(tokens.expires_at * 1000)
    });
    res.send('Strava connected — you can close this tab.');
  } catch (err) {
    res.status(500).send('Strava auth failed: ' + err.message);
  }
});
 
async function refreshStravaTokenIfNeeded(integ) {
  if (new Date(integ.expires_at) > new Date()) return integ.access_token;
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: integ.refresh_token
    })
  });
  const tokens = await res.json();
  await supabase.from('integrations').upsert({
    provider: 'strava',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(tokens.expires_at * 1000)
  });
  return tokens.access_token;
}
 
async function syncStrava() {
  const { data: integ } = await supabase.from('integrations').select('*').eq('provider', 'strava').single();
  if (!integ) return;
  const accessToken = await refreshStravaTokenIfNeeded(integ);
  const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=15', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const activities = await actRes.json();
  for (const a of activities) {
    if (a.type !== 'Run') continue;
    const paceMinPerKm = a.moving_time / 60 / (a.distance / 1000);
    const pm = Math.floor(paceMinPerKm), ps = Math.round((paceMinPerKm - pm) * 60);
    await supabase.from('strava_activities').upsert(
      {
        strava_id: a.id,
        activity_date: a.start_date_local.slice(0, 10),
        distance_km: Math.round((a.distance / 1000) * 100) / 100,
        pace: `${pm}:${ps.toString().padStart(2, '0')}`,
        avg_hr: a.average_heartrate || null,
        title: a.name,
        source: 'api'
      },
      { onConflict: 'strava_id' }
    );
  }
}
 
/* ============================================================
   MANUAL SYNC TRIGGERS + SCHEDULED SYNC
   ============================================================ */
app.all('/api/sync/strava', async (req, res) => {
  try { await syncStrava(); res.json({ ok: true, message: 'Strava sync ran — check your Supabase strava_activities table.' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.all('/api/sync/whoop', async (req, res) => {
  try { await syncWhoop(); res.json({ ok: true, message: 'Whoop sync ran — check your Supabase whoop_recovery table.' }); } catch (err) { res.status(500).json({ error: err.message }); }
});
 
// Auto-sync both every 3 hours
cron.schedule('0 */3 * * *', async () => {
  await syncStrava().catch(() => {});
  await syncWhoop().catch(() => {});
});
 
/* ============================================================
   PLAN — read is open like the rest of the app, writes need the API key.
   The write logic itself lives in plan-service.js, shared with the MCP server.
   ============================================================ */

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: 'STRIDE_API_KEY is not set on the server.' });
  const header = req.get('authorization') || '';
  const supplied = (header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null) || req.get('x-api-key');
  if (supplied !== API_KEY) return res.status(401).json({ error: 'Bad or missing API key.' });
  next();
}

// PlanError = the request didn't make sense (bad date, nothing scheduled, ambiguous day).
// Anything else is a real fault and shouldn't leak its internals to the caller.
function handleError(err, res) {
  if (err instanceof PlanError) return res.status(400).json({ error: err.message, ...err.details });
  console.error(err);
  return res.status(500).json({ error: 'Internal error.' });
}

app.get('/api/plan', async (req, res) => {
  try {
    res.json(await getPlan(supabase, { from_date: req.query.from, to_date: req.query.to }));
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/change-log', async (req, res) => {
  try {
    res.json(await getChangeLog(supabase, { limit: Number(req.query.limit) || 50 }));
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/api/plan/update-session', requireApiKey, async (req, res) => {
  try {
    const { date, status, notes, session_type } = req.body;
    res.json(await updateSession(supabase, { date, status, notes, session_type, source: 'claude' }));
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/api/plan/reschedule-session', requireApiKey, async (req, res) => {
  try {
    const { from_date, to_date, session_type, confirm, reason } = req.body;
    const result = await rescheduleSession(supabase, {
      from_date, to_date, session_type, confirm, reason, source: 'claude'
    });
    // 409 = "I need you to confirm this first", not a failure.
    res.status(result.needs_confirmation ? 409 : 200).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

/* ============================================================
   APP WRITES — same plan-service functions as above, called from Stride's own
   UI (the drag-and-drop calendar and the Coach Jack quick actions) rather than
   from Claude. No API key: the app already sits behind the passcode gate, and
   these follow the same open-write pattern as the older /api/sessions endpoint.
   ============================================================ */

app.post('/api/app/reschedule-session', async (req, res) => {
  try {
    const { from_date, from_type, to_date, session_type, confirm, reason } = req.body;
    const result = await rescheduleSession(supabase, {
      from_date, from_type, to_date, session_type, confirm, reason, source: 'app'
    });
    res.status(result.needs_confirmation ? 409 : 200).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/api/app/quick-action', async (req, res) => {
  try {
    res.json(await applyQuickAction(supabase, { ...req.body, source: 'app' }));
  } catch (err) {
    handleError(err, res);
  }
});

// MCP endpoint — what gets added as a custom connector in Claude.
app.use('/mcp', createMcpRouter(supabase, API_KEY));

app.get('/', (req, res) => res.send('Splits backend is running.'));

app.listen(PORT, () => console.log(`Splits backend listening on ${PORT}`));
