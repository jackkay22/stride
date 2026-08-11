/* Tests for the plan write logic and the MCP connector.
   Run with:  npm test
   Uses an in-memory stand-in for Supabase, so it never touches live data. */

import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { makeFakeSupabase } from './fake-supabase.mjs';
import { planRows } from './seed-fixture.mjs';
import { createMcpRouter } from '../mcp-server.js';
import {
  getPlan, getChangeLog, updateSession, rescheduleSession, slotForDate, PlanError,
} from '../plan-service.js';

const fresh = () =>
  makeFakeSupabase({ plan_sessions: planRows(), change_log: [], sessions_log: [], adapt_log: [] });

/* ---------------- date handling ---------------- */

test('maps dates to the right week and day', () => {
  assert.deepEqual(slotForDate('2026-07-27'), { week: 1, day: 'Mon' });
  assert.deepEqual(slotForDate('2026-09-20'), { week: 8, day: 'Sun' }); // tune-up race
  assert.deepEqual(slotForDate('2026-10-18'), { week: 12, day: 'Sun' }); // race day
});

test('rejects dates outside the block and malformed dates', () => {
  assert.throws(() => slotForDate('2026-07-26'), PlanError);
  assert.throws(() => slotForDate('2026-10-19'), PlanError);
  assert.throws(() => slotForDate('2027-08-01'), PlanError);
  assert.throws(() => slotForDate('15/08/2026'), PlanError);
  assert.throws(() => slotForDate('2026-02-30'), PlanError);
});

/* ---------------- seeded plan ---------------- */

test('plan seeds to 84 sessions and reads back by range', async () => {
  const db = fresh();
  assert.equal((await getPlan(db)).length, 84);
  const wk1 = await getPlan(db, { from_date: '2026-07-27', to_date: '2026-08-02' });
  assert.equal(wk1.length, 7);
  assert.equal(wk1[0].title, 'Easy run + Strength A');
  assert.equal(wk1[6].type, 'long');
});

/* ---------------- update_session ---------------- */

test('logs a session with notes and writes a change-log entry', async () => {
  const db = fresh();
  const res = await updateSession(db, {
    date: '2026-08-11', status: 'niggle', notes: 'left calf tight from 6km',
  });

  assert.equal(res.ok, true);
  assert.equal(res.session.status, 'niggle');
  assert.equal(res.session.notes, 'left calf tight from 6km');
  assert.match(res.adaptation, /Niggle flagged Week 3 Tue/);

  const log = await getChangeLog(db);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'update_session');
  assert.match(log[0].summary, /marked niggle/);
  assert.deepEqual(log[0].before_state, { status: null, notes: null });
  assert.ok(log[0].changed_at);

  // the older table the app reads still gets its row
  assert.equal(db.store.sessions_log.length, 1);
  assert.equal(db.store.sessions_log[0].week, 3);
  assert.equal(db.store.sessions_log[0].day, 'Tue');
});

test('a missed long run produces the reschedule advice', async () => {
  const db = fresh();
  const res = await updateSession(db, { date: '2026-08-16', status: 'miss' });
  assert.match(res.adaptation, /Missed the Week 3 long run/);
});

test('rejects a bad status and an empty day', async () => {
  const db = fresh();
  await assert.rejects(() => updateSession(db, { date: '2026-08-11', status: 'done' }), PlanError);
  await assert.rejects(() => updateSession(db, { date: '2026-11-01', status: 'hit' }), PlanError);
});

/* ---------------- reschedule_session ---------------- */

test('a move inside the same week just happens', async () => {
  const db = fresh();
  // Week 6: Sat easy run -> Fri, same week, same phase
  const res = await rescheduleSession(db, { from_date: '2026-09-05', to_date: '2026-09-04' });

  assert.equal(res.ok, true);
  assert.equal(res.needs_confirmation, undefined);
  assert.equal(res.session.date, '2026-09-04');
  assert.deepEqual(res.session.moved, { from: '2026-09-05', at: res.session.moved.at });
  assert.match(res.summary, /moved from 2026-09-05 to 2026-09-04/);
  assert.deepEqual(res.also_on_that_day, ['rest: Rest, or golf']);

  const log = await getChangeLog(db);
  assert.equal(log[0].action, 'reschedule_session');
  assert.equal(log[0].override, false);
});

test('crossing a phase boundary is flagged back, not actioned', async () => {
  const db = fresh();
  // Week 7 Sun long run (build) -> Week 8 Mon (cutback, decision-gate week)
  const res = await rescheduleSession(db, { from_date: '2026-09-13', to_date: '2026-09-14' });

  assert.equal(res.ok, false);
  assert.equal(res.needs_confirmation, true);
  assert.equal(res.proposed.from_phase, 'build');
  assert.equal(res.proposed.to_phase, 'cutback');
  assert.ok(res.warnings.some((w) => /different week's total/.test(w)));
  assert.ok(res.warnings.some((w) => /crosses a phase boundary/.test(w)));
  assert.ok(res.warnings.some((w) => /load-bearing/.test(w)));

  // nothing moved, nothing logged
  const plan = await getPlan(db, { from_date: '2026-09-13', to_date: '2026-09-13' });
  assert.equal(plan[0].type, 'long');
  assert.equal(plan[0].moved, null);
  assert.equal((await getChangeLog(db)).length, 0);
});

test('the same move goes through once confirmed, and is logged as an override', async () => {
  const db = fresh();
  const res = await rescheduleSession(db, {
    from_date: '2026-09-13', to_date: '2026-09-14', confirm: true, reason: 'work trip',
  });

  assert.equal(res.ok, true);
  assert.equal(res.session.date, '2026-09-14');
  assert.ok(res.confirmed_despite.length >= 2);
  assert.match(res.summary, /work trip/);

  const log = await getChangeLog(db);
  assert.equal(log[0].override, true);
  assert.match(log[0].warnings, /phase boundary/);
  assert.deepEqual(log[0].before_state, {
    session_date: '2026-09-13', session_type: 'long', phase: 'build',
  });
});

test('turning a rest day into a long run inside a cutback week is flagged', async () => {
  const db = fresh();
  // Week 8 Fri is a rest day, in the cutback/decision-gate week
  const res = await rescheduleSession(db, { from_date: '2026-09-18', session_type: 'long' });

  assert.equal(res.needs_confirmation, true);
  assert.ok(res.warnings.some((w) => /cutback week meant to bring load down/.test(w)));
});

test('a plain type swap inside a build week is not flagged', async () => {
  const db = fresh();
  const res = await rescheduleSession(db, { from_date: '2026-09-12', session_type: 'quality' });
  assert.equal(res.ok, true);
  assert.match(res.summary, /type changed easy → quality/);
});

test('rejects nonsense input', async () => {
  const db = fresh();
  await assert.rejects(() => rescheduleSession(db, { from_date: '2026-09-13' }), PlanError);
  await assert.rejects(
    () => rescheduleSession(db, { from_date: '2026-09-13', to_date: '2026-12-01' }), PlanError);
  await assert.rejects(
    () => rescheduleSession(db, { from_date: '2026-09-13', session_type: 'yoga' }), PlanError);
});

test('two sessions on one day forces a disambiguation rather than a guess', async () => {
  const db = fresh();
  await rescheduleSession(db, { from_date: '2026-09-05', to_date: '2026-09-04' });
  await assert.rejects(
    () => updateSession(db, { date: '2026-09-04', status: 'hit' }),
    (err) => err instanceof PlanError && err.details.needs_disambiguation === true
  );
  // naming the type resolves it
  const res = await updateSession(db, { date: '2026-09-04', status: 'hit', session_type: 'easy' });
  assert.equal(res.ok, true);
});

/* ---------------- MCP connector ---------------- */

const KEY = 'test-key-123';

function startMcp() {
  const db = fresh();
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter(db, KEY));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ db, server, port: server.address().port }));
  });
}

// The transport may answer as JSON or as a one-shot SSE stream; accept both.
async function rpc(port, body, { key = KEY, inPath = false } = {}) {
  const url = `http://127.0.0.1:${port}/mcp${inPath && key ? '/' + key : ''}`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (key && !inPath) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!text) return { status: res.status, json: null };
  if (text.startsWith('event:') || text.includes('\ndata: ')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return { status: res.status, json: JSON.parse(line.slice(6)) };
  }
  return { status: res.status, json: JSON.parse(text) };
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
};

test('MCP: rejects a missing or wrong key', async () => {
  const { server, port } = await startMcp();
  try {
    assert.equal((await rpc(port, INIT, { key: null })).status, 401);
    assert.equal((await rpc(port, INIT, { key: 'wrong' })).status, 401);
  } finally { server.close(); }
});

test('MCP: accepts the key in a header or in the URL', async () => {
  const { server, port } = await startMcp();
  try {
    const viaHeader = await rpc(port, INIT);
    assert.equal(viaHeader.status, 200);
    assert.equal(viaHeader.json.result.serverInfo.name, 'stride');

    const viaPath = await rpc(port, INIT, { inPath: true });
    assert.equal(viaPath.status, 200);
    assert.ok(viaPath.json.result.instructions.includes('sub-3:30'));
  } finally { server.close(); }
});

test('MCP: lists the four tools', async () => {
  const { server, port } = await startMcp();
  try {
    await rpc(port, INIT);
    const res = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = res.json.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_change_log', 'get_plan', 'reschedule_session', 'update_session']);
    const resched = res.json.result.tools.find((t) => t.name === 'reschedule_session');
    assert.ok(resched.description.includes('needs_confirmation'));
    assert.ok(resched.inputSchema.properties.confirm);
  } finally { server.close(); }
});

test('MCP: update_session writes through the tool call', async () => {
  const { db, server, port } = await startMcp();
  try {
    await rpc(port, INIT);
    const res = await rpc(port, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'update_session',
        arguments: { date: '2026-08-11', status: 'hit', notes: 'felt good' },
      },
    });
    const payload = JSON.parse(res.json.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.session.notes, 'felt good');
    assert.equal(db.store.change_log.length, 1);
  } finally { server.close(); }
});

test('MCP: a flagged reschedule comes back as a tool error-free warning, unapplied', async () => {
  const { db, server, port } = await startMcp();
  try {
    await rpc(port, INIT);
    const res = await rpc(port, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        name: 'reschedule_session',
        arguments: { from_date: '2026-09-13', to_date: '2026-09-14' },
      },
    });
    const payload = JSON.parse(res.json.result.content[0].text);
    assert.equal(payload.needs_confirmation, true);
    assert.ok(payload.message.includes('confirm: true'));
    assert.equal(db.store.change_log.length, 0);
  } finally { server.close(); }
});

test('MCP: a bad request comes back as a readable error, not a crash', async () => {
  const { server, port } = await startMcp();
  try {
    await rpc(port, INIT);
    const res = await rpc(port, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'update_session', arguments: { date: '2026-12-25', status: 'hit' } },
    });
    assert.equal(res.json.result.isError, true);
    assert.match(res.json.result.content[0].text, /outside the training block/);
  } finally { server.close(); }
});
