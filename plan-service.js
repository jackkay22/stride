/* ============================================================
   PLAN SERVICE — the actual read/write logic for the training plan.
   Both the HTTP endpoints (server.js) and the MCP tools (mcp-server.js)
   call straight into here, so there is one implementation and one set
   of safety checks rather than two that can drift apart.
   ============================================================ */

export const BLOCK_START = '2026-07-27'; // Monday of week 1 — matches index.html
export const TOTAL_WEEKS = 12;
export const RACE_DATE = '2026-10-18';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const VALID_STATUSES = ['hit', 'niggle', 'miss'];
const VALID_TYPES = ['easy', 'long', 'quality', 'strength', 'bike', 'rest', 'event'];

// Weeks where the whole point is that load comes down. Adding hard work here is
// the thing worth stopping to ask about.
const RECOVERY_PHASES = ['cutback', 'taper'];
const HARD_TYPES = ['long', 'quality', 'event'];

/* ---------- dates ---------- */

// Errors we raise deliberately, so callers can tell a bad request from a real fault.
export class PlanError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PlanError';
    this.details = details;
  }
}

function toUTC(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) {
    throw new PlanError(`"${dateStr}" is not a valid date. Use YYYY-MM-DD, e.g. 2026-08-15.`);
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const ts = Date.UTC(y, m - 1, d);
  const back = new Date(ts).toISOString().slice(0, 10);
  if (back !== dateStr) throw new PlanError(`"${dateStr}" is not a real calendar date.`);
  return ts;
}

export function daysFromBlockStart(dateStr) {
  return Math.floor((toUTC(dateStr) - toUTC(BLOCK_START)) / 86400000);
}

// Which week/day of the block a date falls in. Throws if it's outside the 12 weeks —
// deliberately not clamped, so a typo'd year can't quietly land on week 1.
export function slotForDate(dateStr) {
  const idx = daysFromBlockStart(dateStr);
  const week = Math.floor(idx / 7) + 1;
  if (idx < 0 || week > TOTAL_WEEKS) {
    throw new PlanError(
      `${dateStr} is outside the training block (${BLOCK_START} to ${RACE_DATE}).`,
      { block_start: BLOCK_START, race_date: RACE_DATE }
    );
  }
  return { week, day: DAY_NAMES[((idx % 7) + 7) % 7] };
}

/* ---------- lookups ---------- */

async function phaseByWeek(supabase) {
  const { data, error } = await supabase.from('plan_sessions').select('week, phase, week_headline');
  if (error) throw new Error(error.message);
  const map = new Map();
  for (const r of data) if (!map.has(r.week)) map.set(r.week, { phase: r.phase, headline: r.week_headline });
  return map;
}

// Finds the single session sitting on a date. A reschedule can leave two sessions
// on one day, so this reports that back rather than picking one at random.
async function sessionOnDate(supabase, dateStr, { type_hint } = {}) {
  slotForDate(dateStr); // validates the date is in-block before we hit the database
  const { data, error } = await supabase
    .from('plan_sessions')
    .select('*')
    .eq('session_date', dateStr)
    .order('session_type');
  if (error) throw new Error(error.message);

  if (!data.length) {
    throw new PlanError(`Nothing is scheduled on ${dateStr}.`, { date: dateStr });
  }
  if (data.length === 1) return data[0];

  const narrowed = type_hint ? data.filter((s) => s.session_type === type_hint) : [];
  if (narrowed.length === 1) return narrowed[0];

  throw new PlanError(
    `There are ${data.length} sessions on ${dateStr} — say which one you mean.`,
    {
      needs_disambiguation: true,
      date: dateStr,
      candidates: data.map((s) => ({ session_type: s.session_type, title: s.title, targets: s.targets })),
    }
  );
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
  status: s.status,
  notes: s.notes,
  moved: s.session_date !== s.orig_date ? { from: s.orig_date, at: s.moved_at } : null,
});

export async function getPlan(supabase, { from_date, to_date } = {}) {
  let q = supabase.from('plan_sessions').select('*').order('session_date').order('session_type');
  if (from_date) q = q.gte('session_date', from_date);
  if (to_date) q = q.lte('session_date', to_date);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data.map(publicShape);
}

export async function getChangeLog(supabase, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('change_log')
    .select('*')
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

async function recordChange(supabase, entry) {
  const { error } = await supabase.from('change_log').insert(entry);
  // A failure to log shouldn't silently swallow a change that already landed,
  // but it also shouldn't fail the whole request — surface it on the response instead.
  if (error) return `Change applied, but logging it failed: ${error.message}`;
  return null;
}

/* ---------- the adaptive rules, lifted out of POST /api/sessions so both
   the app and Claude produce the same follow-on advice ---------- */
export function adaptMessageFor(week, day, status) {
  if (status === 'miss') {
    if (day === 'Sun') return `Missed the Week ${week} long run — moved to Monday, distance kept the same.`;
    if (day === 'Tue') return `Missed Week ${week}'s quality session — dropped, no reschedule.`;
    return `Missed Week ${week}'s ${day} session — dropped.`;
  }
  if (status === 'niggle') {
    return `Niggle flagged Week ${week} ${day} — next quality session swapped for easy, strength pushed back 48h.`;
  }
  return null;
}

/* ============================================================
   WRITE 1 — update_session
   ============================================================ */
export async function updateSession(supabase, { date, status, notes, session_type, source = 'claude' }) {
  if (!date) throw new PlanError('date is required (YYYY-MM-DD).');
  if (!VALID_STATUSES.includes(status)) {
    throw new PlanError(`status must be one of: ${VALID_STATUSES.join(', ')}.`, { got: status });
  }

  const session = await sessionOnDate(supabase, date, { type_hint: session_type });
  const before = { status: session.status, notes: session.notes };

  const { data: updated, error } = await supabase
    .from('plan_sessions')
    .update({
      status,
      notes: notes ?? session.notes,
      status_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.id)
    .select()
    .single();
  if (error) throw new Error(error.message);

  // Keep the older sessions_log table in step — the app still reads it.
  await supabase.from('sessions_log').insert({
    week: session.week,
    day: session.day,
    status,
    notes: notes ?? null,
    session_date: date,
    source,
  });

  const adaptation = adaptMessageFor(session.week, session.day, status);
  if (adaptation) await supabase.from('adapt_log').insert({ message: adaptation });

  const summary =
    `${date} (W${session.week} ${session.day}, ${session.title}) marked ${status}` +
    (notes ? ` — "${notes}"` : '');

  const logWarning = await recordChange(supabase, {
    action: 'update_session',
    session_id: session.id,
    summary,
    before_state: before,
    after_state: { status, notes: notes ?? session.notes },
    source,
  });

  return {
    ok: true,
    summary,
    session: publicShape(updated),
    adaptation,
    ...(logWarning ? { log_warning: logWarning } : {}),
  };
}

/* ============================================================
   WRITE 2 — reschedule_session
   Moves a session to another date and/or changes its type. Anything that
   shifts load between weeks or drops hard work into a recovery week comes
   back for confirmation first instead of just happening.
   ============================================================ */
export async function rescheduleSession(
  supabase,
  { from_date, to_date, session_type, confirm = false, reason, source = 'claude' }
) {
  if (!from_date) throw new PlanError('from_date is required (YYYY-MM-DD).');
  if (!to_date && !session_type) {
    throw new PlanError('Give a to_date to move the session, a session_type to change it, or both.');
  }
  if (session_type && !VALID_TYPES.includes(session_type)) {
    throw new PlanError(`session_type must be one of: ${VALID_TYPES.join(', ')}.`, { got: session_type });
  }

  const session = await sessionOnDate(supabase, from_date);
  const targetDate = to_date || session.session_date;
  const targetSlot = slotForDate(targetDate);

  const phases = await phaseByWeek(supabase);
  const sourceWeek = slotForDate(session.session_date).week;
  const sourcePhase = phases.get(sourceWeek)?.phase ?? session.phase;
  const targetPhase = phases.get(targetSlot.week)?.phase ?? null;
  const targetHeadline = phases.get(targetSlot.week)?.headline ?? null;

  const newType = session_type || session.session_type;

  /* ---- the checks that get flagged back rather than actioned silently ---- */
  const warnings = [];

  if (targetSlot.week !== sourceWeek) {
    warnings.push(
      `This moves the session out of week ${sourceWeek} into week ${targetSlot.week}, so its load counts toward a different week's total.`
    );
  }
  if (targetPhase && targetPhase !== sourcePhase) {
    warnings.push(
      `It also crosses a phase boundary — from the ${sourcePhase} phase into the ${targetPhase} phase` +
        (targetHeadline ? ` (${targetHeadline})` : '') +
        '.'
    );
  }
  if (RECOVERY_PHASES.includes(targetPhase) && HARD_TYPES.includes(newType) && !HARD_TYPES.includes(session.session_type)) {
    warnings.push(
      `It puts a ${newType} session into week ${targetSlot.week}, which is a ${targetPhase} week meant to bring load down.`
    );
  }
  if (
    RECOVERY_PHASES.includes(targetPhase) &&
    HARD_TYPES.includes(newType) &&
    targetSlot.week !== sourceWeek
  ) {
    warnings.push(`Cutback and taper weeks are the ones your plan notes call load-bearing.`);
  }

  if (warnings.length && !confirm) {
    return {
      ok: false,
      needs_confirmation: true,
      warnings,
      proposed: {
        from_date,
        to_date: targetDate,
        session: { title: session.title, type: session.session_type, targets: session.targets },
        new_type: newType !== session.session_type ? newType : null,
        from_week: sourceWeek,
        to_week: targetSlot.week,
        from_phase: sourcePhase,
        to_phase: targetPhase,
      },
      message:
        'Not applied yet. Check the warnings with Jack, and call this again with confirm: true if he wants it anyway.',
    };
  }

  // Anything already sitting on the destination day, so the move isn't a surprise.
  const { data: existing } = await supabase
    .from('plan_sessions')
    .select('session_type, title')
    .eq('session_date', targetDate)
    .neq('id', session.id);

  const before = {
    session_date: session.session_date,
    session_type: session.session_type,
    phase: session.phase,
  };

  const isMove = targetDate !== before.session_date;
  const isTypeChange = Boolean(session_type) && session_type !== before.session_type;

  const patch = {
    session_date: targetDate,
    updated_at: new Date().toISOString(),
  };
  if (isMove) patch.moved_at = new Date().toISOString();
  if (session_type) patch.session_type = session_type;

  const { data: updated, error } = await supabase
    .from('plan_sessions')
    .update(patch)
    .eq('id', session.id)
    .select()
    .single();
  if (error) throw new Error(error.message);

  // Built from `before`, not `session` — the row object may have been updated in place.
  const parts = [];
  if (isMove) parts.push(`moved from ${before.session_date} to ${targetDate}`);
  if (isTypeChange) parts.push(`type changed ${before.session_type} → ${session_type}`);
  if (!parts.length) parts.push('left unchanged');
  const summary = `"${session.title}" ${parts.join(', ')}` + (reason ? ` — ${reason}` : '');

  const logWarning = await recordChange(supabase, {
    action: 'reschedule_session',
    session_id: session.id,
    summary,
    before_state: before,
    after_state: { session_date: targetDate, session_type: newType },
    source,
    override: warnings.length > 0,
    warnings: warnings.length ? warnings.join(' ') : null,
  });

  const adaptMsg = `Plan updated — ${summary}`;
  await supabase.from('adapt_log').insert({ message: adaptMsg });

  return {
    ok: true,
    summary,
    session: publicShape(updated),
    ...(warnings.length ? { confirmed_despite: warnings } : {}),
    ...(existing?.length
      ? { also_on_that_day: existing.map((e) => `${e.session_type}: ${e.title}`) }
      : {}),
    ...(logWarning ? { log_warning: logWarning } : {}),
  };
}
