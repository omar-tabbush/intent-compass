// Read a vault: decision records, module notes and daily notes.
// Tolerant of the layouts in the wild: frontmatter records, body-bullet records
// ("- Status: accepted"), per-module numbering and free-text statuses.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitFrontmatter, sections, unwiki } from './fm.mjs';
import { normalizePath } from './glob.mjs';
import { fileNumber } from './ids.mjs';

export const TODO_WHY = 'TODO — not recorded. Ask the human why; do not guess.';

const SKIP_DIRS = new Set(['.cache', '.obsidian', '.trash', '.git', 'node_modules']);

export function listMarkdown(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (/^_?templates?$/i.test(e.name)) continue;
        walk(child);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(child);
    }
  };
  walk('');
  return out;
}

export function classify(rel) {
  const segs = rel.split('/');
  const file = segs.at(-1);
  const dirs = segs.slice(0, -1);
  const mi = segs.findIndex((s) => /^modules$/i.test(s));
  // modules/<m>/decisions/… first, so a module may even be called "decisions".
  if (mi !== -1 && dirs.length > mi + 2 && /^decisions$/i.test(segs[mi + 2])) return { kind: 'record', ns: segs[mi + 1] };
  const di = dirs.findIndex((s) => /^decisions$/i.test(s));
  if (di !== -1 && (mi === -1 || di < mi)) return { kind: 'record', ns: 'root' };
  if (mi !== -1) {
    const rest = segs.slice(mi + 1);
    const base = file.replace(/\.md$/i, '');
    if (rest.length === 2 && rest[0] === base) return { kind: 'module', name: base };
    if (rest.length === 1) return { kind: 'module', name: base };
  }
  if (di !== -1) return { kind: 'record', ns: 'root' };
  if (segs.length >= 2 && /^daily$/i.test(segs.at(-2)) && /^\d{4}-\d{2}-\d{2}\.md$/.test(file)) {
    return { kind: 'daily', date: file.slice(0, 10) };
  }
  return { kind: 'other' };
}

const STATUS_TABLE = [
  [/^(accept|approv|decided|built|done|active|adopt|implement|agreed|final|shipped|live)/, 'accepted'],
  [/^(supersed|replaced)/, 'superseded'],
  [/^(deprecat|obsolete|retired|rejected|abandon|withdrawn|reverted|dropped)/, 'deprecated'],
  [/^(propos|draft|pending|open|todo|wip|idea|suggest|review)/, 'proposed'],
];
// "Not accepted", "no longer active", "never implemented", "unapproved".
const NEGATED = /^(?:not|no|non|never)\b|\bno longer\b|\b(?:not|never|non|un)[\s-]*(?:accept|approv|adopt|implement|agreed|decided)/;
const ACCEPT_WORD = /(accept|approv|adopt|implement|agreed|decided|active|final|live)/;
const REJECT_WORD = /^(reject|abandon|withdrawn|deprecat|obsolete|retired|dropped|reverted)/;

// Free-text status -> one of proposed | accepted | superseded | deprecated | unknown.
// A negated or rejected status never reads as accepted: an agent would follow it as a rule.
export function normalizeStatus(raw) {
  const s = String(unwiki(raw) ?? '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (NEGATED.test(s)) return ACCEPT_WORD.test(s) ? 'deprecated' : 'unknown';
  const words = s.split(/[^a-z]+/).filter(Boolean);
  const first = s.split(/[\s(,;:—-]+/)[0];
  let v = null;
  for (const [re, st] of STATUS_TABLE) if (re.test(first)) { v = st; break; }
  if (!v && /in progress/.test(s)) v = 'proposed';
  // "Proposal rejected", "Draft (abandoned)": the proposal is over.
  if ((v === null || v === 'proposed') && words.some((w) => REJECT_WORD.test(w))) return 'deprecated';
  if (v) return v;
  // "Design approved": the first word that means something wins.
  for (const word of words) {
    for (const [re, st] of STATUS_TABLE) if (re.test(word)) return st;
  }
  return 'unknown';
}

// "- Status: accepted" and "**Status:** accepted" lines before the first "## " heading.
// Exported so intent accept edits exactly the line this reader takes as the status.
export const BODY_META_RES = [
  /^\s*[-*]\s+\*\*([A-Za-z][\w -]{0,30}?):?\*\*:?\s*(.+)$/,
  /^\s*[-*]\s+([A-Za-z][\w -]{0,30}?):\s+(.+)$/,
  /^\s*\*\*([A-Za-z][\w -]{0,30}?):?\*\*:?\s*(.+)$/,
];

export function metaKey(k) {
  return k.trim().toLowerCase().replace(/\s+/g, '-');
}

// "- Supersedes:" with nothing after it; its value is on the indented lines below.
const EMPTY_META_RES = [
  /^\s*[-*]\s+\*\*([A-Za-z][\w -]{0,30}?):?\*\*:?\s*$/,
  /^\s*[-*]\s+([A-Za-z][\w -]{0,30}?):\s*$/,
  /^\s*\*\*([A-Za-z][\w -]{0,30}?):?\*\*:?\s*$/,
];

function bodyMeta(body) {
  const meta = {};
  let open = null; // the key whose value may go on over indented lines
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) break;
    const m = BODY_META_RES.map((re) => line.match(re)).find(Boolean) || EMPTY_META_RES.map((re) => line.match(re)).find(Boolean);
    if (m) {
      const k = metaKey(m[1]);
      open = k in meta ? null : k;
      if (open) meta[k] = (m[2] ?? '').trim();
    } else if (open && /^\s{2,}\S/.test(line) && !/^\s*[-*]\s/.test(line) && !/^\s*\*\*/.test(line)) {
      meta[open] = `${meta[open]} ${line.trim()}`.trim();
    } else open = null;
  }
  for (const [k, v] of Object.entries(meta)) if (v === '') delete meta[k];
  return meta;
}

// "Status: Accepted" or "Review Date:" in frontmatter read like their lowercase keys; an exact key wins.
function foldKeys(data) {
  const out = { ...data };
  for (const [k, v] of Object.entries(data)) {
    const low = metaKey(k);
    if (!Object.hasOwn(out, low)) out[low] = v;
  }
  return out;
}

// "superseded by [[x|0003]])": drop a stray closing bracket, but keep a wikilink's own "]]".
export function trimUnbalanced(s) {
  let t = String(s).trim();
  const count = (c) => t.split(c).length - 1;
  while (/[)\]]$/.test(t) && (count('(') < count(')') || count('[') < count(']'))) t = t.slice(0, -1).trimEnd();
  return t;
}

function list(v) {
  if (v === null || v === undefined || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(/,\s*/);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

// Backticked repo paths in a body: `src/a/b.ts`, `prisma/schema/`, `src/x.ts:12`.
export function extractRefs(body) {
  const out = new Set();
  for (const m of body.matchAll(/`([^`\n]{3,200})`/g)) {
    let s = m[1].trim();
    if (/^[a-z]+:\/\//i.test(s) || /\s/.test(s) || !s.includes('/')) continue;
    s = s.replace(/:\d+(?:-\d+)?$/, '').replace(/#L\d+.*$/, '');
    if (!/^[\w@.\-[\]()]+(\/[\w@.\-[\]()]+)*\/?$/.test(s)) continue;
    if (s.startsWith('/') || s.startsWith('../') || s.startsWith('~')) continue;
    const last = s.replace(/\/$/, '').split('/').at(-1);
    if (!s.endsWith('/') && !last.includes('.')) continue; // needs an extension or a trailing slash
    out.add(normalizePath(s));
  }
  return [...out].sort();
}

const WHY_RE = /^(why|rationale|reason|the intent|intent)\b/i;
const CONTEXT_RE = /^(context|background|problem)\b/i;

export function hasRationale(text) {
  if (!text) return false;
  const t = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  return t.length > 0 && !/^todo\b/i.test(t);
}

export function parseRecord(rel, text, { ns = 'root', moduleNames = new Set() } = {}) {
  const { data, body, hasFrontmatter } = splitFrontmatter(text);
  const bm = bodyMeta(body);
  const meta = { ...bm, ...foldKeys(data) };
  const secs = sections(body);
  const file = rel.split('/').at(-1).replace(/\.md$/i, '');
  const rawId = meta.id !== undefined && meta.id !== null ? String(unwiki(meta.id)).trim() : '';
  let id;
  let num = fileNumber(file);
  if (rawId.includes('/')) id = rawId;
  else if (/^\d+$/.test(rawId)) { num = rawId.padStart(4, '0'); id = `${ns}/${num}`; }
  else if (rawId) id = `${ns}/${rawId}`;
  else if (num) id = `${ns}/${num}`;
  else id = `${ns}/${file}`;

  const declaredModule = meta.module ? String(unwiki(meta.module)).replace(/^modules\//, '').split('/')[0] : null;
  let module = ns;
  if (ns === 'root' && declaredModule && moduleNames.has(declaredModule)) module = declaredModule;

  const why = secs.get(WHY_RE);
  const context = secs.get(CONTEXT_RE);
  const statusRaw = meta.status === undefined || meta.status === null ? '' : String(meta.status);
  const status = normalizeStatus(statusRaw);
  const supersededBy = list(meta['superseded-by'] ?? meta.superseded_by ?? meta.supersededBy);
  const inlineBy = statusRaw.match(/superseded\s+by\s+(.+)$/i);
  if (inlineBy && status === 'superseded') supersededBy.push(trimUnbalanced(inlineBy[1]));

  return {
    id,
    ns,
    num,
    path: rel,
    module,
    title: String(meta.title || secs.title || file).trim(),
    status,
    statusRaw,
    date: dateOf(meta.date) || dateOf(file),
    reviewDate: dateOf(meta.review_date ?? meta['review-date'] ?? meta.reviewDate),
    provenance: meta.provenance ? String(meta.provenance) : null,
    governs: list(meta.governs).map((g) => normalizePath(unwiki(g))),
    refs: extractRefs(body),
    supersedesRaw: list(meta.supersedes).map(String),
    supersededByRaw: supersededBy.map(String),
    tags: list(meta.tags).map(String),
    missingWhy: !(hasRationale(why) || (why === null && hasRationale(context))),
    schema: hasFrontmatter ? 'frontmatter' : Object.keys(bm).length ? 'body-bullets' : 'none',
    source: meta.source ? String(meta.source) : null,
  };
}

// YYYY-MM-DD that is a real calendar day.
export function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// The first real date in v: "2026-10-01", or eight digits "20261001" standing alone.
function dateOf(v) {
  if (!v) return null;
  const s = String(v);
  for (const m of s.matchAll(/(\d{4}-\d{2}-\d{2})/g)) if (validDate(m[1])) return m[1];
  for (const m of s.matchAll(/(?:^|\D)(?=(\d{4})(\d{2})(\d{2})(?:\D|$))/g)) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    if (validDate(d)) return d;
  }
  return null;
}

export function parseModule(rel, text, name) {
  const { data: raw, body } = splitFrontmatter(text);
  const data = foldKeys(raw);
  const secs = sections(body);
  return {
    name,
    path: rel,
    title: String(data.title || secs.title || name),
    governs: list(data.governs).map((g) => normalizePath(unwiki(g))),
  };
}

// A file in a decisions folder that is a record, not a README or loose note: it has a number,
// a status, a declared id or a "## Decision" section, and is not named README or index.
export function looksLikeRecord(p, body) {
  const base = p.path.split('/').at(-1).replace(/\.md$/i, '');
  if (/^(readme|index)$/i.test(base)) return false;
  return Boolean(p.num || p.statusRaw.trim() || p.id !== `${p.ns}/${base}` || /^##\s+decision\b/im.test(body));
}

export function loadVault(ctx) {
  const dir = ctx.vaultDir;
  const out = { records: [], modules: [], dailies: [], problems: [] };
  if (!existsSync(dir)) return out;
  const files = listMarkdown(dir);
  const kinds = files.map((rel) => [rel, classify(rel)]);
  for (const [rel, k] of kinds) {
    if (k.kind !== 'module') continue;
    try { out.modules.push(parseModule(rel, readFileSync(join(dir, rel), 'utf8'), k.name)); }
    catch (e) { out.problems.push({ kind: 'parse', path: rel, message: e.message }); }
  }
  const moduleNames = new Set(out.modules.map((m) => m.name));
  for (const [rel, k] of kinds) {
    if (k.kind === 'record') {
      try {
        const text = readFileSync(join(dir, rel), 'utf8');
        const r = parseRecord(rel, text, { ns: k.ns, moduleNames });
        if (looksLikeRecord(r, splitFrontmatter(text).body)) out.records.push(r);
        else out.problems.push({ kind: 'parse', path: rel, message: 'not a decision record (no number, status or ## Decision); skipped' });
      } catch (e) { out.problems.push({ kind: 'parse', path: rel, message: e.message }); }
    } else if (k.kind === 'daily') out.dailies.push({ date: k.date, path: rel });
  }
  return out;
}
