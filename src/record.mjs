// Render new records. Only facts and text a human (or the session) supplied go in;
// anything missing stays as an explicit TODO.

import { stringifyFrontmatter } from './fm.mjs';
import { TODO_WHY } from './vault.mjs';

export const SECTION_ORDER = [
  ['context', 'Context'],
  ['decision', 'Decision'],
  ['why', 'Why — the intent'],
  ['alternatives', 'Alternatives rejected'],
  ['consequences', 'Consequences'],
];

const TODO = 'TODO';

export function renderRecord(meta, body = {}) {
  const fm = {
    id: meta.id,
    title: meta.title,
    status: meta.status || 'proposed',
    date: meta.date,
    module: meta.module,
    governs: meta.governs || [],
    provenance: meta.provenance || 'human',
    review_date: meta.review_date ?? null,
    supersedes: meta.supersedes || [],
    tags: meta.tags || [],
  };
  for (const [k, v] of Object.entries(meta.extra || {})) fm[k] = v;
  let out = stringifyFrontmatter(fm);
  out += `# ${meta.title}\n`;
  for (const [key, heading] of SECTION_ORDER) {
    const text = body[key] && String(body[key]).trim() ? String(body[key]).trim() : key === 'why' ? TODO_WHY : TODO;
    out += `\n## ${heading}\n\n${text}\n`;
  }
  return out;
}

export function addMonths(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// date + config.reviewMonths, or null when reviews are turned off (0 or not a number).
export function reviewDateFor(date, months) {
  const n = Number(months);
  return Number.isFinite(n) && n > 0 ? addMonths(date, n) : null;
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
