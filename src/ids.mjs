// ID allocation. Numbers are allocated here, never chosen by a model. The record folder
// is checked right before writing, so two agents in one checkout rarely pick the same one;
// if they still do, the index reports a duplicate-id problem.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function slugify(title) {
  const s = String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s.slice(0, 60).replace(/-+$/, '') || 'decision');
}

// A filename that starts with a date (2023-10-05-x.md, 20231005-x.md) carries no record number.
export const DATED_NAME = /^(?:\d{4}-\d{2}-\d{2}|(?:19|20)\d{6})(?=[-_ .]|$)/;

// The record number at the start of a filename, padded like a numeric id, or null.
export function fileNumber(name) {
  if (DATED_NAME.test(name)) return null;
  const m = name.match(/^(\d+)(?=[-_ .]|$)/);
  return m ? m[1].padStart(4, '0') : null;
}

// One past the highest number in use in ns: declared ids "<ns>/NNNN" wherever the file is,
// and the filename numbers of the namespace's own folder. Non-numeric ids never count.
export function nextNumber(index, ns) {
  let max = 0;
  const bump = (v) => { if (typeof v === 'string' && /^\d+$/.test(v)) max = Math.max(max, parseInt(v, 10)); };
  for (const r of index.records) {
    const cut = r.id.lastIndexOf('/');
    if (cut !== -1 && r.id.slice(0, cut) === ns) bump(r.id.slice(cut + 1));
    if (r.ns === ns) bump(r.num);
  }
  return String(max + 1).padStart(4, '0');
}

// The first number from num up that no file in the namespace's record folder uses. The index
// can be a moment old when another agent has just written a record.
export function freeNumber(vaultDir, ns, num) {
  const dir = join(vaultDir, ns === 'root' ? 'decisions' : `modules/${ns}/decisions`);
  let names = [];
  try { names = readdirSync(dir); } catch { /* no folder yet */ }
  const used = new Set(names.map(fileNumber).filter(Boolean).map((n) => parseInt(n, 10)));
  let n = parseInt(num, 10);
  while (used.has(n)) n++;
  return String(n).padStart(4, '0');
}

export function recordRelPath(ns, num, slug) {
  const file = `${num}-${slug}.md`;
  return ns === 'root' ? `decisions/${file}` : `modules/${ns}/decisions/${file}`;
}

export function moduleRelPath(name) {
  return `modules/${name}/${name}.md`;
}

// "decisions", "modules" and "daily" are vault folder names: a module called that would be misread.
export function validModuleName(name) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) && name !== 'root' && !name.includes('..') && !/^(decisions|modules|daily)$/i.test(name);
}
