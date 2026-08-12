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

// Date arithmetic in UTC so it can't be nudged a day by a server timezone.
function shiftISO(dateStr, days) {
  return new Date(toUTC(dateStr) + days * 86400000).toISOString().slice(0, 10);
}

// Pulls a date back inside the block rather than throwing — used where a window
// runs off the end (e.g. "ease off for 3 days" started in race week).
function clampToBlock(dateStr) {
  if (dateStr < BLOCK_START) return BLOCK_START;
  if (dateStr > RACE_DATE) return RACE_DATE;
  return dateStr;
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
  {
    from_date,
    to_date,
    session_type,
    from_type,
    title,
    targets,
    detail,
    confirm = false,
    reason,
    source = 'claude',
  }
) {
  if (!from_date) throw new PlanError('from_date is required (YYYY-MM-DD).');
  // Rewriting a session's wording in place is a valid edit on its own — that's how
  // the quick actions leave "easing off" / heat guidance on a session they downgrade.
  const rewritesCopy = title !== undefined || targets !== undefined || detail !== undefined;
  if (!to_date && !session_type && !rewritesCopy) {
    throw new PlanError('Give a to_date to move the session, a session_type to change it, or both.');
  }
  if (session_type && !VALID_TYPES.includes(session_type)) {
    throw new PlanError(`session_type must be one of: ${VALID_TYPES.join(', ')}.`, { got: session_type });
  }

  // from_type only narrows which session is meant when a day holds two — which a
  // reschedule can itself create, so drag-and-drop needs a way to say which card moved.
  const session = await sessionOnDate(supabase, from_date, { type_hint: from_type });
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
    ...(rewritesCopy
      ? { title: session.title, targets: session.targets, detail: session.detail }
      : {}),
  };

  const isMove = targetDate !== before.session_date;
  const isTypeChange = Boolean(session_type) && session_type !== before.session_type;
  const isCopyChange =
    (title !== undefined && title !== session.title) ||
    (targets !== undefined && targets !== session.targets) ||
    (detail !== undefined && detail !== session.detail);

  const patch = {
    session_date: targetDate,
    updated_at: new Date().toISOString(),
  };
  if (isMove) patch.moved_at = new Date().toISOString();
  if (session_type) patch.session_type = session_type;
  if (title !== undefined) patch.title = title;
  if (targets !== undefined) patch.targets = targets;
  if (detail !== undefined) patch.detail = detail;

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
  if (isCopyChange) parts.push(`rewritten as "${patch.title ?? session.title}"`);
  if (!parts.length) parts.push('left unchanged');
  const summary = `"${before.title ?? session.title}" ${parts.join(', ')}` + (reason ? ` — ${reason}` : '');

  const logWarning = await recordChange(supabase, {
    action: 'reschedule_session',
    session_id: session.id,
    summary,
    before_state: before,
    after_state: {
      session_date: targetDate,
      session_type: newType,
      ...(rewritesCopy
        ? { title: updated.title, targets: updated.targets, detail: updated.detail }
        : {}),
    },
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

/* ============================================================
   WRITE 3 — quick actions
   The presets behind the app's chat-style buttons. Every one of these is a
   fixed rule composed out of updateSession/rescheduleSession above — there is
   no model, no API call and no generated text anywhere in here. The wording
   that comes back is the copy table at the bottom of this file, chosen by
   which branch of the rule ran.
   ============================================================ */

// Markers used to make each preset idempotent: pressing "hot weather" twice
// shouldn't stack two paragraphs of guidance onto the same session.
const EASE_MARKER = 'easing off';
const HOLIDAY_MARKER = 'Away — nothing scheduled';
const HEAT_MARKER = 'Heat guidance:';

const EASE_DAYS = 3;      // how far forward "feeling ill" reaches
const MAX_HOLIDAY_DAYS = 28;

// What each session type becomes when illness eases the plan off. Rest and event
// are absent on purpose: a rest day needs no easing, and a race is never quietly
// downgraded by a button press.
const EASE_RULES = {
  quality: { type: 'easy', title: `Easy run — ${EASE_MARKER}`, targets: '20–30 min very easy' },
  long: { type: 'easy', title: `Easy run — ${EASE_MARKER}`, targets: '20–30 min very easy' },
  easy: { type: 'easy', title: `Easy run — ${EASE_MARKER}`, targets: '20–30 min very easy' },
  bike: { type: 'rest', title: `Rest — ${EASE_MARKER}`, targets: '' },
  strength: { type: 'rest', title: `Rest — ${EASE_MARKER}`, targets: '' },
};
const EASE_DETAIL =
  'Eased off because you were feeling ill. Only do this if you actually want to — ' +
  'skipping it entirely costs you nothing at this stage of the block.';

const HOLIDAY_DETAIL =
  "Holiday mode: nothing is being asked of you today. Run if you get the chance and " +
  'feel like it, at whatever pace the day allows. No target, and nothing to make up afterwards.';

const HEAT_DETAIL_HARD =
  `${HEAT_MARKER} add 10–20 sec/km to every target pace and run to effort, not to the watch. ` +
  'Threshold work drops to marathon effort, marathon-pace work drops to steady. Take 500ml of ' +
  'fluid per hour, and move the session to early morning or evening if the day allows it.';
const HEAT_DETAIL_EASY =
  `${HEAT_MARKER} keep it genuinely conversational and let the pace go 10–20 sec/km slower than ` +
  'usual — easy days get easier in the heat, not harder. Carry fluid if you are out over 40 minutes.';

async function sessionsInRange(supabase, fromDate, toDate) {
  slotForDate(fromDate);
  slotForDate(toDate);
  const { data, error } = await supabase
    .from('plan_sessions')
    .select('*')
    .gte('session_date', fromDate)
    .lte('session_date', toDate)
    .order('session_date')
    .order('session_type');
  if (error) throw new Error(error.message);
  return data;
}

/* Every preset that rewrites sessions goes through here, so they all get the
   same change-log trail and the same "a day with two sessions is ambiguous"
   handling — one awkward session is skipped and reported, not left half-applied. */
async function applyRewrites(supabase, rows, ruleFor, reason, source) {
  const changes = [];
  const skipped = [];
  for (const row of rows) {
    const rule = ruleFor(row);
    if (!rule) continue;
    try {
      const res = await rescheduleSession(supabase, {
        from_date: row.session_date,
        from_type: row.session_type,
        session_type: rule.type,
        title: rule.title,
        targets: rule.targets,
        detail: rule.detail,
        reason,
        // These rules only ever take load out of the plan, never add it, so there
        // is nothing here for the confirmation checks to catch.
        confirm: true,
        source,
      });
      changes.push(res.summary);
    } catch (err) {
      if (err instanceof PlanError) skipped.push(`${row.session_date}: ${err.message}`);
      else throw err;
    }
  }
  return { changes, skipped };
}

/* ---- preset: hit / niggle / missed ---- */
async function statusAction(supabase, { preset, date, session_type, notes, source }) {
  if (!date) throw new PlanError('date is required (YYYY-MM-DD).');
  const res = await updateSession(supabase, { date, status: preset, notes, session_type, source });
  const session = res.session;

  // updateSession's own adaptation text still lands in adapt_log (the "Adjustments"
  // view keeps it), but it isn't repeated in the chat reply here: for a missed long
  // run the accurate version comes from the real follow-up below, and duplicating
  // a second fixed line on top of the coach's line would just read as noise.
  const reply = [COACH[preset](session)];

  // A missed long run is the one case where the plan wants to actually move
  // something rather than just note it. Sunday → Monday crosses a week boundary,
  // which is exactly what the reschedule checks exist to flag, so it's offered
  // back as a follow-up rather than done behind Jack's back.
  const followUp = preset === 'miss' ? await proposeLongRunMove(supabase, session, source) : null;

  return {
    ok: true,
    preset,
    coach: followUp ? [...reply, followUp.prompt] : reply,
    changes: [res.summary],
    ...(followUp ? { follow_up: followUp.action } : {}),
  };
}

async function proposeLongRunMove(supabase, session, source) {
  if (session.type !== 'long') return null;

  const next = shiftISO(session.date, 1);
  if (next > RACE_DATE) return null;

  // Only offer the move onto a day that is genuinely clear.
  const { data: onNext } = await supabase
    .from('plan_sessions')
    .select('session_type')
    .eq('session_date', next);
  if ((onNext || []).some((s) => s.session_type !== 'rest')) return null;

  // Calling without confirm is a dry run: it returns the warnings and changes
  // nothing. If there were no warnings to raise it will have simply moved it,
  // which is the right outcome too — just reported differently.
  const dry = await rescheduleSession(supabase, {
    from_date: session.date,
    from_type: 'long',
    to_date: next,
    reason: 'missed long run',
    source,
  });

  if (dry.ok) {
    return {
      prompt: COACH.longRunMoved(next),
      action: { kind: 'done', summary: dry.summary },
    };
  }

  return {
    prompt: COACH.longRunOffer(next),
    action: {
      kind: 'reschedule',
      label: 'Yes, move it',
      decline_label: 'No, let it go',
      from_date: session.date,
      from_type: 'long',
      to_date: next,
      warnings: dry.warnings,
      declined_reply: COACH.longRunDeclined(),
    },
  };
}

/* ---- preset: feeling ill ---- */
async function easeOff(supabase, { date, source }) {
  if (!date) throw new PlanError('date is required (YYYY-MM-DD).');
  const from = clampToBlock(date);
  const to = clampToBlock(shiftISO(from, EASE_DAYS - 1));

  const rows = await sessionsInRange(supabase, from, to);
  const { changes, skipped } = await applyRewrites(
    supabase,
    rows,
    (row) => {
      const rule = EASE_RULES[row.session_type];
      if (!rule) return null;                                  // rest and event are left alone
      if ((row.title || '').includes(EASE_MARKER)) return null; // already eased off
      return { ...rule, detail: EASE_DETAIL };
    },
    'feeling ill — easing off',
    source
  );

  return {
    ok: true,
    preset: 'ill',
    coach: [changes.length ? COACH.ill(changes.length, to) : COACH.illNothingToDo()],
    changes,
    window: { from_date: from, to_date: to },
    ...(skipped.length ? { skipped } : {}),
  };
}

/* ---- preset: holiday mode ---- */
async function holidayMode(supabase, { from_date, to_date, source }) {
  if (!from_date || !to_date) {
    throw new PlanError('Holiday mode needs a from_date and a to_date (YYYY-MM-DD).');
  }
  if (to_date < from_date) throw new PlanError('The holiday end date is before its start date.');
  const span = Math.round((toUTC(to_date) - toUTC(from_date)) / 86400000) + 1;
  if (span > MAX_HOLIDAY_DAYS) {
    throw new PlanError(`Holiday mode covers up to ${MAX_HOLIDAY_DAYS} days at a time.`, { got_days: span });
  }

  const rows = await sessionsInRange(supabase, from_date, to_date);
  const { changes, skipped } = await applyRewrites(
    supabase,
    rows,
    (row) => {
      if (row.session_type === 'event') return null;            // never stands down a race
      if (row.session_type === 'rest') return null;             // already nothing to do
      if ((row.title || '').includes(HOLIDAY_MARKER)) return null;
      return { type: 'rest', title: HOLIDAY_MARKER, targets: '', detail: HOLIDAY_DETAIL };
    },
    'holiday mode',
    source
  );

  const backOn = shiftISO(to_date, 1);
  const races = rows.filter((r) => r.session_type === 'event');

  const coach = [changes.length ? COACH.holiday(changes.length, backOn) : COACH.holidayNothingToDo()];
  if (races.length) coach.push(COACH.holidayRace(races[0].session_date));

  return {
    ok: true,
    preset: 'holiday',
    coach,
    changes,
    window: { from_date, to_date },
    ...(skipped.length ? { skipped } : {}),
  };
}

/* ---- preset: hot weather ---- */
async function heatAdjust(supabase, { date, session_type, source }) {
  if (!date) throw new PlanError('date is required (YYYY-MM-DD).');
  const session = await sessionOnDate(supabase, date, { type_hint: session_type });

  if (session.session_type === 'rest') {
    return { ok: true, preset: 'heat', coach: [COACH.heatRestDay()], changes: [] };
  }
  if ((session.detail || '').includes(HEAT_MARKER)) {
    return { ok: true, preset: 'heat', coach: [COACH.heatAlready()], changes: [] };
  }

  const hard = HARD_TYPES.includes(session.session_type);
  const guidance = hard ? HEAT_DETAIL_HARD : HEAT_DETAIL_EASY;

  const res = await rescheduleSession(supabase, {
    from_date: date,
    from_type: session.session_type,
    // Type and date stay exactly as they are — heat changes the guidance, not the plan.
    targets: session.targets ? `${session.targets} · heat-adjusted` : 'heat-adjusted',
    detail: session.detail ? `${session.detail}\n\n${guidance}` : guidance,
    reason: 'hot weather',
    confirm: true,
    source,
  });

  return {
    ok: true,
    preset: 'heat',
    coach: [hard ? COACH.heatHard() : COACH.heatEasy()],
    changes: [res.summary],
    session: res.session,
  };
}

/* The single entry point the app calls. */
export async function applyQuickAction(supabase, { preset, source = 'app', ...args } = {}) {
  switch (preset) {
    case 'hit':
    case 'niggle':
    case 'miss':
      return statusAction(supabase, { preset, source, ...args });
    case 'ill':
      return easeOff(supabase, { source, ...args });
    case 'holiday':
      return holidayMode(supabase, { source, ...args });
    case 'heat':
      return heatAdjust(supabase, { source, ...args });
    default:
      throw new PlanError(
        `Unknown quick action "${preset}". Expected one of: hit, niggle, miss, ill, holiday, heat.`
      );
  }
}

/* ============================================================
   COACH JACK — the fixed reply copy.
   Every string below is written out here in full. Which one comes back is
   decided by the rules above, so the app can show a coach's voice without
   anything being generated at request time.
   ============================================================ */
const ukDate = (dateStr) => {
  const d = new Date(toUTC(dateStr));
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
};

const COACH = {
  hit: () => "Logged. That's another one banked — the block is built out of exactly these.",
  niggle: () =>
    "Thanks for flagging it rather than pushing on. I've noted it against the session — " +
    "if it's still there tomorrow, we back off properly rather than hoping.",
  miss: (s) =>
    s.type === 'long'
      ? "Missed long runs happen. Nothing is written off yet — let's see if we can find it a home."
      : "Fine. That one's gone rather than crammed in somewhere it doesn't belong. " +
        'The next session stands exactly as planned.',
  longRunOffer: (next) =>
    `I can move it to ${ukDate(next)} with the distance untouched. That does push the load ` +
    'into next week, so it is your call.',
  longRunMoved: (next) => `Moved to ${ukDate(next)}, distance kept the same.`,
  longRunDeclined: () =>
    "Left where it was. One missed long run doesn't undo a block — we carry on as scheduled.",
  ill: (n, to) =>
    `Sorry to hear it. I've eased off the next ${EASE_DAYS} days — ${n} ${n === 1 ? 'session' : 'sessions'} ` +
    `dropped to easy or rest through to ${ukDate(to)}. Come back when you're properly over it, not a day before.`,
  illNothingToDo: () =>
    "Sorry to hear it. There's nothing demanding in the next few days to ease off, so just rest " +
    'and pick it up when you feel human again.',
  holiday: (n, backOn) =>
    `Enjoy it. ${n} ${n === 1 ? 'session is' : 'sessions are'} off the hook — run if you get the chance, ` +
    `don't if you don't. We pick the block back up on ${ukDate(backOn)}.`,
  holidayNothingToDo: () =>
    "Nothing to stand down in those dates — you're already clear. Enjoy the break.",
  holidayRace: (date) =>
    `One thing I've left alone: the race on ${ukDate(date)}. That stays in the plan — say the word if it shouldn't.`,
  heatHard: () =>
    "Right, hot one. I've added 10–20 sec/km to the targets and dropped the hard efforts a gear. " +
    'Run to effort today — the pace will look slow and that is the correct answer in this heat.',
  heatEasy: () =>
    "Noted. Easy stays easy in the heat, which means slower — 10–20 sec/km off the usual, and take fluid with you.",
  heatRestDay: () => "It's a rest day, so the heat is somebody else's problem. Stay out of it.",
  heatAlready: () => "Already heat-adjusted — the guidance is on the session.",
};
