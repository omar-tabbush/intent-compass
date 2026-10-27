// Read a vault: decision records, module notes and daily notes.
// Tolerant of the layouts in the wild: frontmatter records, body-bullet records
// ("- Status: accepted"), per-module numbering and free-text statuses.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitFrontmatter, sections, unwiki } from './fm.mjs';
import { normalizePath } from './glob.mjs';

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
  const di = segs.slice(0, -1).findIndex((s) => /^decisions$/i.test(s));
  if (di !== -1) {
    const mi = segs.findIndex((s) => /^modules$/i.test(s));
    const ns = mi !== -1 && mi + 2 === di ? segs[mi + 1] : 'root';
    return { kind: 'record', ns };
  }
  const mi = segs.findIndex((s) => /^modules$/i.test(s));
  if (mi !== -1) {
    const rest = segs.slice(mi + 1);
    const base = file.replace(/\.md$/i, '');
    if (rest.length === 2 && rest[0] === base) return { kind: 'module', name: base };
    if (rest.length === 1) return { kind: 'module', name: base };
  }
  if (segs.length >= 2 && /^daily$/i.test(segs.at(-2)) && /^\d{4}-\d{2}-\d{2}\.md$/.test(file)) {
    return { kind: 'daily', date: file.slice(0, 10) };
  }
  return { kind: 'other' };
}

// Free-text status -> one of proposed | accepted | superseded | deprecated | unknown.
export function normalizeStatus(raw) {
  const s = String(unwiki(raw) ?? '').toLowerCase().trim();
  if (!s) return 'unknown';
  const first = s.split(/[\s(,;:—-]+/)[0];
  const table = [
    [/^(accept|approv|decided|built|done|active|adopt|implement|agreed|final|shipped|live)/, 'accepted'],
    [/^(supersed|replaced)/, 'superseded'],
    [/^(deprecat|obsolete|retired|rejected|abandon|withdrawn|reverted|dropped)/, 'deprecated'],
    [/^(propos|draft|pending|open|todo|wip|idea|suggest|review)/, 'proposed'],
  ];
  for (const [re, v] of table) if (re.test(first)) return v;
  if (/in progress/.test(s)) return 'proposed';
  // "Design approved": the first word that means something wins.
  for (const word of s.split(/[^a-z]+/).filter(Boolean)) {
    for (const [re, v] of table) if (re.test(word)) return v;
  }
  return 'unknown';
}

// "- Status: accepted" and "**Status:** accepted" lines before the first "## " heading.
function bodyMeta(body) {
  const meta = {};
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) break;
    const m =
      line.match(/^\s*[-*]\s+\*\*([A-Za-z][\w -]{0,30}?):?\*\*:?\s*(.+)$/) ||
      line.match(/^\s*[-*]\s+([A-Za-z][\w -]{0,30}?):\s+(.+)$/) ||
      line.match(/^\s*\*\*([A-Za-z][\w -]{0,30}?):?\*\*:?\s*(.+)$/);
    if (m) {
      const k = m[1].trim().toLowerCase().replace(/\s+/g, '-');
      if (!(k in meta)) meta[k] = m[2].trim();
    }
  }
  return meta;
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
  const meta = { ...bm, ...data };
  const secs = sections(body);
  const file = rel.split('/').at(-1).replace(/\.md$/i, '');
  const numMatch = file.match(/^(\d+)(?=[-_ ]|$)/);
  const rawId = meta.id !== undefined && meta.id !== null ? String(unwiki(meta.id)).trim() : '';
  let id;
  let num = numMatch ? numMatch[1] : null;
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
  if (inlineBy && status === 'superseded') supersededBy.push(inlineBy[1].replace(/[)\]]+$/, '').trim());

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

function dateOf(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4}-\d{2}-\d{2})/) || String(v).match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/);
  if (!m) return null;
  return m.length === 2 ? m[1] : `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseModule(rel, text, name) {
  const { data, body } = splitFrontmatter(text);
  const secs = sections(body);
  return {
    name,
    path: rel,
    title: String(data.title || secs.title || name),
    governs: list(data.governs).map((g) => normalizePath(unwiki(g))),
  };
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
      try { out.records.push(parseRecord(rel, readFileSync(join(dir, rel), 'utf8'), { ns: k.ns, moduleNames })); }
      catch (e) { out.problems.push({ kind: 'parse', path: rel, message: e.message }); }
    } else if (k.kind === 'daily') out.dailies.push({ date: k.date, path: rel });
  }
  return out;
}
