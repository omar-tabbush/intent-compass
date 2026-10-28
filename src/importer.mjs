// Import an Obsidian-style vault into this vault. The source is only ever read;
// writes go into the target vault, and a file that already exists there is never overwritten.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { splitFrontmatter, stringifyFrontmatter, unwiki } from './fm.mjs';
import { region } from './generated.mjs';
import { isoDate } from './record.mjs';
import { classify, loadVault, looksLikeRecord, parseModule, parseRecord } from './vault.mjs';

const TEMPLATE_DIR = /^_?templates?$/i;
const TEMPLATE_FILE = /^(?:0+[-_ ])?_?templates?$/i;
const EMPTY_FM = /^﻿?---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY_RE = /^([^\s:#][^:]*?)\s*:(?:\s+(.*)|\s*)$/;
const DECISIONS_START = '<!-- intent:generated:decisions:start -->';

// Original keys whose value the import rewrites. Everything else is kept verbatim.
const RECORD_KEYS = new Set([
  'id', 'title', 'status', 'status_raw', 'date', 'module', 'governs', 'provenance',
  'review_date', 'review-date', 'reviewDate', 'supersedes', 'superseded-by', 'superseded_by',
  'supersededBy', 'tags', 'source', 'imported_at',
]);
const MODULE_KEYS = new Set(['type', 'module', 'governs', 'source', 'imported_at']);

// --- where things are -------------------------------------------------------

// Real path of p, even when p (or its tail) does not exist yet.
function realish(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(basename(cur));
    cur = up;
  }
  let real = cur;
  try { real = (realpathSync.native || realpathSync)(cur); } catch { /* keep the resolved path */ }
  return join(real, ...tail);
}

function contains(dir, p) {
  const r = relative(dir, p);
  return r === '' || !(r === '..' || r.startsWith('..' + sep) || isAbsolute(r));
}

// Throws unless srcDir is a folder that neither contains nor sits inside the target vault.
export function checkSource(srcDir, vaultDir) {
  const src = resolve(srcDir);
  let st;
  try { st = statSync(src); } catch { throw new Error(`source not found: ${src}`); }
  if (!st.isDirectory()) throw new Error(`source is not a folder: ${src}`);
  const a = realish(src);
  const b = realish(vaultDir);
  if (a === b) throw new Error(`the source and the target vault are the same folder (${a})`);
  if (contains(a, b)) throw new Error(`the target vault ${b} is inside the source ${a}; import never writes into its source`);
  if (contains(b, a)) throw new Error(`the source ${a} is inside the target vault ${b}`);
}

// Every markdown note in the source, plus what was left out and why.
function scan(src) {
  const notes = [];
  const skipped = [];
  const walk = (rel, inTemplates) => {
    let entries;
    try { entries = readdirSync(join(src, rel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.')) {
        skipped.push({ from: e.isDirectory() ? child + '/' : child, reason: e.name === '.obsidian' ? 'obsidian config' : 'hidden' });
      } else if (e.isSymbolicLink()) skipped.push({ from: child, reason: 'symlink' });
      else if (e.isDirectory()) {
        if (e.name === 'node_modules') skipped.push({ from: child + '/', reason: 'ignored folder' });
        else walk(child, inTemplates || TEMPLATE_DIR.test(e.name));
      } else if (e.isFile()) {
        if (inTemplates) skipped.push({ from: child, reason: 'template' });
        else if (!/\.md$/i.test(e.name)) skipped.push({ from: child, reason: 'not markdown' });
        else notes.push(child);
      }
    }
  };
  walk('', false);
  return { notes, skipped };
}

// modules/<m>/<m>.md (any case) or flat modules/<m>.md -> m.
function moduleNameOf(segs) {
  const mi = segs.findIndex((s) => /^modules$/i.test(s));
  if (mi === -1) return null;
  const rest = segs.slice(mi + 1);
  const base = rest.at(-1).replace(/\.md$/i, '');
  if (rest.length === 1) return base;
  if (rest.length === 2 && rest[0].toLowerCase() === base.toLowerCase()) return rest[0];
  return null;
}

function kindOf(rel, text) {
  const segs = rel.split('/');
  if (TEMPLATE_FILE.test(segs.at(-1).replace(/\.md$/i, ''))) return { kind: 'skip', reason: 'template' };
  const k = classify(rel);
  if (k.kind === 'record') return k;
  if (k.kind === 'daily') return { kind: 'skip', reason: 'daily note' };
  const name = moduleNameOf(segs);
  if (name) return { kind: 'module', name };
  if (segs.length === 1 && /\[\[[^\]]+\]\]/.test(text)) return { kind: 'skip', reason: 'hub note' };
  return { kind: 'skip', reason: 'not a record or module note' };
}

// The target path keeps the source layout below the decisions folder.
function recordTarget(rel, ns) {
  const segs = rel.split('/');
  const di = segs.slice(0, -1).findIndex((s) => /^decisions$/i.test(s));
  const rest = segs.slice(di + 1).join('/');
  return ns === 'root' ? `decisions/${rest}` : `modules/${ns}/decisions/${rest}`;
}

// --- building the new notes -------------------------------------------------

function splitSource(text) {
  const empty = text.match(EMPTY_FM);
  if (empty) return { data: {}, body: text.slice(empty[0].length), fmText: '' };
  const { data, body, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter) return { data, body: body.replace(/^﻿/, ''), fmText: '' };
  const head = text.slice(0, text.length - body.length);
  const fmText = head.replace(/^﻿?---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '');
  return { data, body, fmText };
}

// Top-level frontmatter keys with their original lines, so unknown keys survive byte for byte.
function fmBlocks(fmText) {
  const blocks = [];
  if (!fmText) return blocks;
  for (const line of fmText.split(/\r?\n/)) {
    const kv = !/^\s/.test(line) && !/^-(\s|$)/.test(line) && line.match(KEY_RE);
    if (kv) blocks.push({ key: kv[1].trim(), lines: [line] });
    else if (blocks.length) blocks.at(-1).lines.push(line);
    else blocks.push({ key: null, lines: [line] });
  }
  for (const b of blocks) while (b.lines.length > 1 && !b.lines.at(-1).trim()) b.lines.pop();
  return blocks.filter((b) => b.lines.some((l) => l.trim()));
}

function keptBlocks(fmText, consumed) {
  return fmBlocks(fmText).filter((b) => b.key === null || !consumed.has(b.key));
}

function compose(fm, blocks, body) {
  for (const b of blocks) if (b.key) delete fm[b.key];
  let head = stringifyFrontmatter(fm);
  if (blocks.length) head = head.slice(0, -'---\n'.length) + blocks.map((b) => b.lines.join('\n')).join('\n') + '\n---\n';
  return head + body;
}

function toList(v) {
  if (v === null || v === undefined || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(/,\s*/)).map((x) => String(x).trim()).filter(Boolean);
}

const sameList = (a, b) => JSON.stringify(toList(a)) === JSON.stringify(b);
const plain = (v) => String(unwiki(v) ?? '').trim();

// Original values the normalized frontmatter would lose, kept as <key>_raw.
function rawExtras(pairs) {
  const out = {};
  for (const [key, value, same] of pairs) {
    if (value !== null && value !== undefined && !same(value)) out[`${key}_raw`] = value;
  }
  return out;
}

function sameId(v, p) {
  const s = plain(v);
  return s === p.id || `${p.ns}/${s}` === p.id || (/^\d+$/.test(s) && `${p.ns}/${s.padStart(4, '0')}` === p.id);
}

function statusRawOf(p, data) {
  const raw = p.statusRaw.trim();
  if (raw && raw.toLowerCase() !== p.status) return raw;
  return data.status_raw ?? undefined;
}

function recordNote(from, text, ns, moduleNames, today) {
  const p = parseRecord(from, text, { ns, moduleNames });
  const { data, body, fmText } = splitSource(text);
  if (!looksLikeRecord(p, body)) return null;
  const fm = {
    id: p.id,
    title: p.title,
    status: p.status,
    status_raw: statusRawOf(p, data),
    date: p.date,
    module: p.module,
    governs: p.governs,
    provenance: 'imported',
    review_date: p.reviewDate,
    supersedes: p.supersedesRaw,
    superseded_by: [...p.supersededByRaw],
    tags: p.tags,
    source: from,
    imported_at: today,
    ...rawExtras([
      ['id', data.id, (v) => sameId(v, p)],
      ['date', data.date, (v) => String(v).trim() === p.date],
      ['module', data.module, (v) => plain(v) === p.module],
      ['governs', data.governs, (v) => sameList(v, p.governs)],
      ['provenance', data.provenance, (v) => String(v) === 'imported'],
      ['review_date', data.review_date ?? data['review-date'] ?? data.reviewDate, (v) => String(v).trim() === p.reviewDate],
      ['source', data.source, (v) => String(v) === from],
      ['imported_at', data.imported_at, (v) => String(v) === today],
    ]),
  };
  return { id: p.id, status: p.status, text: compose(fm, keptBlocks(fmText, RECORD_KEYS), body) };
}

function moduleNote(from, text, name, today) {
  const m = parseModule(from, text, name);
  const { data, body, fmText } = splitSource(text);
  const fm = {
    type: 'module',
    module: name,
    governs: m.governs,
    source: from,
    imported_at: today,
    ...rawExtras([
      ['type', data.type, (v) => String(v) === 'module'],
      ['module', data.module, (v) => plain(v) === name],
      ['governs', data.governs, (v) => sameList(v, m.governs)],
      ['source', data.source, (v) => String(v) === from],
      ['imported_at', data.imported_at, (v) => String(v) === today],
    ]),
  };
  // A new file in the target, so the markers are appended after the verbatim body
  // (unless the note already has a marker line; one quoted in prose does not count).
  const next = new RegExp(`^[ \\t]*${DECISIONS_START}[ \\t]*\\r?$`, 'm').test(body)
    ? body
    : body + (body === '' || body.endsWith('\n') ? '' : '\n') + '\n' + region('decisions', '') + '\n';
  return { governs: m.governs, text: compose(fm, keptBlocks(fmText, MODULE_KEYS), next) };
}

function sourceOf(file) {
  try {
    const v = splitFrontmatter(readFileSync(file, 'utf8')).data.source;
    return v === null || v === undefined ? null : String(v);
  } catch {
    return null;
  }
}

// --- the import -------------------------------------------------------------

export function importVault(ctx, srcDir, { now = new Date(), dryRun = false } = {}) {
  const src = resolve(srcDir);
  checkSource(src, ctx.vaultDir);
  const today = isoDate(now);
  const out = { source: src, dryRun, imported: [], modules: [], skipped: [], warnings: [] };
  const { notes, skipped } = scan(src);
  out.skipped.push(...skipped);

  const items = [];
  for (const from of notes) {
    const text = readFileSync(join(src, from), 'utf8');
    const k = kindOf(from, text);
    if (k.kind === 'skip') out.skipped.push({ from, reason: k.reason });
    else items.push({ ...k, from, text });
  }

  const target = loadVault(ctx);
  const realSrc = realish(src);
  const realVault = realish(ctx.vaultDir);
  const moduleNames = new Set([...items.filter((i) => i.kind === 'module').map((i) => i.name), ...target.modules.map((m) => m.name)]);
  const planned = new Map();

  // Returns true when the file is (or in a dry run would be) written.
  const place = (from, to, text) => {
    const key = to.toLowerCase();
    if (planned.has(key)) {
      out.skipped.push({ from, reason: 'target exists' });
      out.warnings.push(`${from} maps to ${to}, which ${planned.get(key)} already uses; not imported`);
      return false;
    }
    planned.set(key, from);
    const file = join(ctx.vaultDir, to);
    if (existsSync(file)) {
      if (sourceOf(file) === from) { out.skipped.push({ from, reason: 'already imported' }); return false; }
      out.skipped.push({ from, reason: 'target exists' });
      out.warnings.push(`${to} already exists in the vault and was not imported from ${from}; left it unchanged`);
      return false;
    }
    // A folder in the vault may be a symlink: the real place written to must be in the vault, never in the source.
    const real = realish(dirname(file));
    if (contains(realSrc, real) || !contains(realVault, real)) {
      out.skipped.push({ from, reason: 'target outside the vault' });
      out.warnings.push(`${from} would be written to ${real}, which is outside the target vault or inside the source; not imported`);
      return false;
    }
    if (!dryRun) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, { flag: 'wx' });
    }
    return true;
  };

  for (const it of items.filter((i) => i.kind === 'module')) {
    if (it.name.toLowerCase() === 'root') out.warnings.push(`module folder "${it.name}" shares its name with the cross-cutting namespace "root"`);
    const to = `modules/${it.name}/${it.name}.md`;
    const note = moduleNote(it.from, it.text, it.name, today);
    if (place(it.from, to, note.text)) out.modules.push({ from: it.from, to, name: it.name, governs: note.governs });
  }

  const byId = new Map();
  const existing = new Map();
  for (const r of target.records) existing.set(r.id, [...(existing.get(r.id) || []), r]);
  for (const it of items.filter((i) => i.kind === 'record')) {
    const rec = recordNote(it.from, it.text, it.ns, moduleNames, today);
    if (!rec) { out.skipped.push({ from: it.from, reason: 'not a record' }); continue; }
    byId.set(rec.id, [...(byId.get(rec.id) || []), it.from]);
    const to = recordTarget(it.from, it.ns);
    if (!place(it.from, to, rec.text)) continue;
    out.imported.push({ from: it.from, to, id: rec.id, status: rec.status });
    const clash = (existing.get(rec.id) || []).filter((r) => r.source !== it.from);
    if (clash.length) out.warnings.push(`${rec.id} from ${it.from} has the same ID as ${clash.map((r) => r.path).join(', ')} already in the vault`);
  }
  for (const [id, froms] of byId) {
    if (froms.length > 1) out.warnings.push(`duplicate id ${id} in the source: ${froms.join(', ')} (all kept as they are; renumber by hand if needed)`);
  }
  out.skipped.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return out;
}

// --- reporting --------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Module notes without governs, from the rebuilt index when there is one.
export function ungovernedModules(result, index = null) {
  const mods = index ? index.modules : result.modules;
  return mods.filter((m) => !m.governs.length).map((m) => m.name);
}

export function importReport(result, { source, vault, index = null } = {}) {
  const lines = [];
  const verb = result.dryRun ? 'Would import' : 'Imported';
  lines.push(`${verb} ${plural(result.imported.length, 'record')} and ${plural(result.modules.length, 'module note')} from ${source} into ${vault}.`);
  if (result.skipped.length) {
    const counts = new Map();
    for (const s of result.skipped) counts.set(s.reason, (counts.get(s.reason) || 0) + 1);
    lines.push(`Skipped: ${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  }
  for (const w of result.warnings) lines.push(`  ! ${w}`);
  const ungoverned = ungovernedModules(result, index);
  if (ungoverned.length) {
    lines.push(`Modules with no governs: ${ungoverned.join(', ')}`);
    lines.push('  Add governs: [paths] to these module notes so intent why can find them.');
  }
  if (index) for (const p of index.problems) lines.push(`  ! ${p.kind}: ${p.message} (${p.path})`);
  if (result.dryRun) lines.push('Dry run: nothing was written.');
  return lines;
}
