import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../plan-schema.js';

function validDoc(overrides = {}) {
  return {
    meta: {
      race_name: 'Test 10K',
      race_date: '2026-11-08', // a Sunday, 2 weeks after block_start
      target_time: '0:50:00',
      block_start: '2026-10-26', // a Monday
      total_weeks: 2,
    },
    sessions: [
      { week: 1, day: 'Mon', date: '2026-10-26', session_type: 'easy', title: 'Easy run', targets: '5km', detail: null, exercises: null, phase: 'build', week_km: '20', week_headline: null },
      { week: 1, day: 'Tue', date: '2026-10-27', session_type: 'rest', title: 'Rest day', targets: null, detail: null, exercises: null, phase: 'build', week_km: '20', week_headline: null },
      { week: 1, day: 'Wed', date: '2026-10-28', session_type: 'quality', title: 'Intervals', targets: '6x400m', detail: '6x400m at 5k pace', exercises: null, phase: 'build', week_km: '20', week_headline: null },
      { week: 1, day: 'Thu', date: '2026-10-29', session_type: 'strength', title: 'Strength', targets: null, detail: null, exercises: ['Squats 3x8', 'Lunges 3x8'], phase: 'build', week_km: '20', week_headline: null },
      { week: 1, day: 'Fri', date: '2026-10-30', session_type: 'rest', title: 'Rest', targets: null, detail: null, exercises: null, phase: 'build', week_km: '20', week_headline: null },
      { week: 1, day: 'Sat', date: '2026-10-31', session_type: 'bike', title: 'Easy spin', targets: '30min', detail: null, exercises: null, phase: 'build', week_km: '20', week_headline: null },
      { week: 1, day: 'Sun', date: '2026-11-01', session_type: 'long', title: 'Long run', targets: '10km', detail: null, exercises: null, phase: 'build', week_km: '20', week_headline: null },
      { week: 2, day: 'Mon', date: '2026-11-02', session_type: 'easy', title: 'Easy run', targets: '5km', detail: null, exercises: null, phase: 'taper', week_km: '10', week_headline: 'Race week' },
      { week: 2, day: 'Tue', date: '2026-11-03', session_type: 'rest', title: 'Rest', targets: null, detail: null, exercises: null, phase: 'taper', week_km: '10', week_headline: 'Race week' },
      { week: 2, day: 'Wed', date: '2026-11-04', session_type: 'easy', title: 'Shakeout', targets: '3km', detail: null, exercises: null, phase: 'taper', week_km: '10', week_headline: 'Race week' },
      { week: 2, day: 'Thu', date: '2026-11-05', session_type: 'rest', title: 'Rest', targets: null, detail: null, exercises: null, phase: 'taper', week_km: '10', week_headline: 'Race week' },
      { week: 2, day: 'Fri', date: '2026-11-06', session_type: 'rest', title: 'Rest', targets: null, detail: null, exercises: null, phase: 'taper', week_km: '10', week_headline: 'Race week' },
      { week: 2, day: 'Sat', date: '2026-11-07', session_type: 'rest', title: 'Rest', targets: null, detail: null, exercises: null, phase: 'taper', week_km: '10', week_headline: 'Race week' },
      { week: 2, day: 'Sun', date: '2026-11-08', session_type: 'event', title: 'RACE DAY', targets: '10K', detail: null, exercises: null, phase: 'taper', week_km: 'Race', week_headline: 'Race week' },
    ],
    ...overrides,
  };
}

test('accepts a well-formed plan and normalises it for insert', () => {
  const result = validatePlan(validDoc());
  assert.equal(result.ok, true);
  assert.equal(result.plan.sessions.length, 14);
  assert.equal(result.plan.meta.race_date, '2026-11-08');
  assert.equal(result.plan.sessions[0].session_date, '2026-10-26');
  assert.equal(result.plan.sessions[0].orig_date, '2026-10-26');
});

test('rejects a non-object document', () => {
  const result = validatePlan([1, 2, 3]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /single JSON object/);
});

test('rejects a plan missing meta', () => {
  const doc = validDoc();
  delete doc.meta;
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Missing "meta"')));
});

test('rejects an invalid race_date', () => {
  const doc = validDoc();
  doc.meta.race_date = '08/11/2026';
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('race_date')));
});

test('rejects block_start on/after race_date', () => {
  const doc = validDoc();
  doc.meta.block_start = '2026-11-08';
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('before meta.race_date')));
});

test('rejects an empty sessions array', () => {
  const doc = validDoc({ sessions: [] });
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Missing or empty "sessions"')));
});

test('rejects a bad session_type with a specific message', () => {
  const doc = validDoc();
  doc.sessions[2].session_type = 'run';
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('session_type') && e.includes('week 1, Wed')));
});

test('rejects a missing title', () => {
  const doc = validDoc();
  delete doc.sessions[0].title;
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"title"')));
});

test('rejects exercises that are not a list of strings', () => {
  const doc = validDoc();
  doc.sessions[3].exercises = [{ name: 'Squats' }];
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"exercises"')));
});

test('rejects a date that does not match week/day given block_start', () => {
  const doc = validDoc();
  doc.sessions[6].date = '2026-11-02'; // should be 2026-11-01 for week 1 Sun
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("doesn't match week")));
});

test('rejects a duplicate week/day pair', () => {
  const doc = validDoc();
  doc.sessions.push({ ...doc.sessions[0] });
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate entry')));
});

test('reports multiple independent errors at once, not just the first', () => {
  const doc = validDoc();
  doc.sessions[0].session_type = 'nope';
  doc.sessions[1].day = 'Someday';
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

test('accepts null for optional fields', () => {
  const doc = validDoc();
  doc.sessions[0].targets = null;
  doc.sessions[0].detail = null;
  doc.sessions[0].week_headline = null;
  const result = validatePlan(doc);
  assert.equal(result.ok, true);
});

test('rejects an implausibly large sessions array', () => {
  const doc = validDoc();
  const base = doc.sessions[0];
  doc.sessions = Array.from({ length: 501 }, (_, i) => ({ ...base, week: i + 1 }));
  const result = validatePlan(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('more than a sane plan')));
});
