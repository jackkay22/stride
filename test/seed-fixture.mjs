/* Builds the same 84 plan_sessions rows that seed_plan.sql creates, read straight
   from the plan in index.html. Used by the tests so fixtures can't drift from the plan. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const DAY_OFFSET = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function planRows() {
  const html = fs.readFileSync(path.join(root, '..', 'index.html'), 'utf8');
  const grab = (n) => eval(html.match(new RegExp(`const ${n} = (\\[[\\s\\S]*?\\]);`))[1]);
  const STRENGTH_A = grab('STRENGTH_A');
  const STRENGTH_B = grab('STRENGTH_B');
  const WEEKS = eval(html.match(/let WEEKS = (\[[\s\S]*?\n\]);/)[1]);

  const rows = [];
  WEEKS.forEach((w, i) => {
    w.sessions.forEach((s) => {
      const d = new Date(Date.UTC(2026, 6, 27));
      d.setUTCDate(d.getUTCDate() + i * 7 + DAY_OFFSET[s.day]);
      const date = d.toISOString().slice(0, 10);
      rows.push({
        id: `w${i + 1}-${s.day}`,
        session_date: date,
        orig_date: date,
        week: i + 1,
        day: s.day,
        session_type: s.type,
        title: s.title,
        targets: s.targets || null,
        detail: s.detail || null,
        exercises: s.exercises || null,
        phase: w.phase,
        week_km: String(w.km),
        week_headline: w.headline || null,
        status: null,
        notes: null,
        status_updated_at: null,
        moved_at: null,
      });
    });
  });
  return rows;
}
