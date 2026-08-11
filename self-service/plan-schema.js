/* ============================================================
   PLAN SCHEMA — the JSON shape a self-service user's uploaded plan must
   match, and the validator that checks it.

   There was no prior "manual upload" implementation in this repo to reuse
   a schema from (the referenced stride-plan-upload-brief.md doesn't exist
   here), so this is defined fresh — deliberately shaped to match the
   columns Jack's personal plan_sessions table already uses (see
   ../schema.sql and ../seed_plan.sql), so the app's session-rendering
   logic and this upload path agree on one definition rather than two.

   Used by server.js (validate before insert) and described in plain
   language, with a filled-in example, on generate-plan.html — so what a
   user's own Claude conversation is told to produce and what this file
   actually accepts are the same thing.
   ============================================================ */

export const VALID_SESSION_TYPES = ['easy', 'long', 'quality', 'strength', 'bike', 'rest', 'event'];
export const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10) === s;
}

function dayOffset(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/**
 * Validates an uploaded plan document.
 *
 * Returns { ok: true, plan } with the document normalised into rows ready
 * to insert, or { ok: false, errors } with one plain-English line per
 * problem found. Every session-level error names which session it's about
 * (by position and, where available, week/day) so a mistake is easy to
 * trace back to the source conversation with Claude.
 */
export function validatePlan(doc) {
  const errors = [];

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      ok: false,
      errors: ['The file needs to be a single JSON object with "meta" and "sessions" keys — see the example on the Generate Plan page.'],
    };
  }

  const meta = doc.meta;
  let blockStart = null;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    errors.push('Missing "meta" object (race_date, block_start, total_weeks, etc).');
  } else {
    if (!isValidDate(meta.race_date)) errors.push('meta.race_date must be a real date in YYYY-MM-DD format.');
    if (!isValidDate(meta.block_start)) {
      errors.push('meta.block_start must be a real date in YYYY-MM-DD format (the Monday your plan starts).');
    } else {
      blockStart = meta.block_start;
    }
    if (isValidDate(meta.block_start) && isValidDate(meta.race_date) && meta.block_start >= meta.race_date) {
      errors.push('meta.block_start must be before meta.race_date.');
    }
    if (!Number.isInteger(meta.total_weeks) || meta.total_weeks < 1 || meta.total_weeks > 52) {
      errors.push('meta.total_weeks must be a whole number between 1 and 52.');
    }
    if (meta.race_name != null && typeof meta.race_name !== 'string') errors.push('meta.race_name must be text if present.');
    if (meta.target_time != null && typeof meta.target_time !== 'string') {
      errors.push('meta.target_time must be text if present, e.g. "3:30:00".');
    }
  }

  if (!Array.isArray(doc.sessions) || doc.sessions.length === 0) {
    errors.push('Missing or empty "sessions" array — the plan needs at least one session.');
    return { ok: false, errors };
  }
  if (doc.sessions.length > 500) {
    errors.push(`"sessions" has ${doc.sessions.length} entries — that's more than a sane plan (max 500). Check nothing got duplicated.`);
    return { ok: false, errors };
  }

  const seen = new Set();
  doc.sessions.forEach((s, i) => {
    const label = `Session ${i + 1}` + (s && Number.isInteger(s.week) && s.day ? ` (week ${s.week}, ${s.day})` : '');
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`${label}: must be an object.`);
      return;
    }

    if (!Number.isInteger(s.week) || s.week < 1) errors.push(`${label}: "week" must be a whole number, 1 or higher.`);
    if (!VALID_DAYS.includes(s.day)) errors.push(`${label}: "day" must be one of ${VALID_DAYS.join(', ')} — got ${JSON.stringify(s.day)}.`);
    if (!isValidDate(s.date)) errors.push(`${label}: "date" must be YYYY-MM-DD.`);
    if (!VALID_SESSION_TYPES.includes(s.session_type)) {
      errors.push(`${label}: "session_type" must be one of ${VALID_SESSION_TYPES.join(', ')} — got ${JSON.stringify(s.session_type)}.`);
    }
    if (!s.title || typeof s.title !== 'string') errors.push(`${label}: "title" is required text.`);
    if (s.targets != null && typeof s.targets !== 'string') errors.push(`${label}: "targets" must be text if present.`);
    if (s.detail != null && typeof s.detail !== 'string') errors.push(`${label}: "detail" must be text if present.`);
    if (s.exercises != null && (!Array.isArray(s.exercises) || s.exercises.some((e) => typeof e !== 'string'))) {
      errors.push(`${label}: "exercises" must be a list of text strings if present.`);
    }
    if (!s.phase || typeof s.phase !== 'string') errors.push(`${label}: "phase" is required text, e.g. "build" or "taper".`);
    if (s.week_km != null && typeof s.week_km !== 'string') errors.push(`${label}: "week_km" must be text if present.`);
    if (s.week_headline != null && typeof s.week_headline !== 'string') errors.push(`${label}: "week_headline" must be text if present.`);

    // date must agree with week/day given block_start — catches a plan where
    // Claude's day-counting drifted, without the human having to check by hand.
    if (blockStart && isValidDate(s.date) && Number.isInteger(s.week) && VALID_DAYS.includes(s.day)) {
      const expectedOffset = (s.week - 1) * 7 + VALID_DAYS.indexOf(s.day);
      if (dayOffset(blockStart, s.date) !== expectedOffset) {
        errors.push(`${label}: "date" (${s.date}) doesn't match week ${s.week} / ${s.day} counting from block_start ${blockStart}.`);
      }
    }

    if (Number.isInteger(s.week) && VALID_DAYS.includes(s.day)) {
      const key = `${s.week}-${s.day}`;
      if (seen.has(key)) errors.push(`${label}: duplicate entry for week ${s.week} ${s.day} — each week/day pair can only appear once.`);
      seen.add(key);
    }
  });

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      meta: {
        race_name: meta.race_name ?? null,
        race_date: meta.race_date,
        target_time: meta.target_time ?? null,
        block_start: meta.block_start,
        total_weeks: meta.total_weeks,
      },
      sessions: doc.sessions.map((s) => ({
        session_date: s.date,
        orig_date: s.date,
        week: s.week,
        day: s.day,
        session_type: s.session_type,
        title: s.title,
        targets: s.targets ?? null,
        detail: s.detail ?? null,
        exercises: s.exercises ?? null,
        phase: s.phase,
        week_km: s.week_km ?? null,
        week_headline: s.week_headline ?? null,
      })),
    },
  };
}
