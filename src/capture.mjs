// Capture: draft proposed records for changed code that no decision governs.
// Generated text is facts only (file lists, dates); the Why always stays the TODO marker.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { CONFIG_FILE, vaultPath } from './config.mjs';
import { changedFiles, git, isGitRepo } from './git.mjs';
import { globBase, isUnder, matchPath, normalizePath } from './glob.mjs';
import { ACTIVE, governing, loadIndex, refresh } from './index.mjs';
import { freeNumber, nextNumber, recordRelPath, slugify } from './ids.mjs';
import { isoDate, renderRecord, reviewDateFor } from './record.mjs';
import { wikilink } from './generated.mjs';
import { claimSession, clearSession, readSession } from './session.mjs';

export const TODO_DECISION = 'TODO — state the rule this change follows, in the present tense.';
const RULES_NAMES = new Set(['AGENTS.md', 'CLAUDE.md']);
const MAX_LISTED = 30;

export function inVault(ctx, rel) {
  return ctx.vaultInRepo && ctx.vaultRel !== '.' && isUnder(rel, ctx.vaultRel);
}

// A newline (or any control character) in a file name could plant markdown in a record.
const CONTROL = /[\x00-\x1f\x7f]/;

// Repo-relative posix path of p (absolute, or relative to base), or null when it is outside the
// repo or has control characters in it.
export function repoPath(ctx, p, base = ctx.root) {
  const rel = ctx.rel(String(p), base);
  return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) && !CONTROL.test(rel) ? normalizePath(rel) : null;
}

// Text from paths put into markdown: one line, always.
export const mdSafe = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, ' ');

function skipFile(ctx, rel) {
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return true;
  if (inVault(ctx, rel)) return true;
  if (rel === CONFIG_FILE || isUnder(rel, '.claude') || isUnder(rel, '.git')) return true;
  if (rel.split('/').at(-1) === '.gitignore') return true; // ignore rules are tooling config, not a decision
  if (RULES_NAMES.has(rel.split('/').at(-1)) || (ctx.config.rulesFiles || []).includes(rel)) return true;
  return (ctx.config.ignore || []).some((g) => matchPath(g, rel));
}

function knownToGit(root, rel) {
  try { return git(root, ['log', '-1', '--format=%H', '--', rel]).trim() !== ''; } catch { return false; }
}

function checkSince(ctx, since) {
  if (!since) return;
  if (!isGitRepo(ctx.root)) throw new Error('--since needs a git repository');
  try { git(ctx.root, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`]); } catch { throw new Error(`unknown git ref: ${since}`); }
}

function collect(ctx, since, extraFiles) {
  const fromGit = new Set(changedFiles(ctx.root, since));
  const all = new Set(fromGit);
  for (const f of readSession(ctx).files) if (f && typeof f.path === 'string') all.add(normalizePath(f.path));
  for (const f of extraFiles) { const r = repoPath(ctx, f); if (r) all.add(r); }
  const changed = [];
  const deleted = [];
  const unsafe = [];
  for (const rel of [...all].sort()) {
    if (CONTROL.test(rel)) { unsafe.push(rel); continue; }
    if (skipFile(ctx, rel)) continue;
    const file = join(ctx.root, rel);
    if (existsSync(file)) {
      if (statSync(file).isDirectory()) continue;
    } else {
      // A deletion is a change; a path git never knew (a typo, a temp file) is not.
      if (!fromGit.has(rel) && !knownToGit(ctx.root, rel)) continue;
      deleted.push(rel);
    }
    changed.push(rel);
  }
  return { changed, deleted, unsafe };
}

// First config.areaDepth folders under the code root. A file above that level is governed by its exact path.
function codeArea(ctx, rel) {
  const d = Number(ctx.config.areaDepth);
  const depth = Number.isInteger(d) && d >= 0 ? d : 1; // the same rule as check's areaFolders()
  const roots = (ctx.config.codeRoots || [])
    .map((r) => normalizePath(r).replace(/\/$/, '').replace(/^\.$/, ''))
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (!isUnder(rel, root)) continue;
    const folders = (root ? rel.slice(root.length + 1) : rel).split('/').slice(0, -1);
    if (folders.length >= depth) {
      const area = [root, ...folders.slice(0, depth)].filter(Boolean).join('/');
      return area ? { area, glob: `${area}/**` } : { area: '.', glob: '**' };
    }
    return { area: [root, ...folders].filter(Boolean).join('/') || '.', glob: null };
  }
  return null;
}

function topArea(rel) {
  const segs = rel.split('/');
  return segs.length > 1 ? { area: segs[0], glob: `${segs[0]}/**` } : { area: '.', glob: null };
}

// The most specific module note that governs the file, with the glob that matched.
function governingModule(g, rel) {
  let best = null;
  for (const { module } of g.modules) {
    const glob = module.governs.find((x) => matchPath(x, rel));
    if (!glob) continue;
    if (!best || globBase(glob).length > globBase(best.glob).length) best = { module, glob };
  }
  return best;
}

function groupOf(ctx, g, rel) {
  const m = governingModule(g, rel);
  if (m) return { key: `module:${m.module.name}`, area: m.module.name, module: m.module.name, glob: m.glob };
  const a = codeArea(ctx, rel) || topArea(rel);
  return { key: `area:${a.area}`, area: a.area, module: null, glob: a.glob };
}

// Coverage counts a record's own governs and its module note, not mere mentions.
const direct = (reason) => reason.startsWith('governs ') || reason.startsWith('in module ');

export function areaLabel(area) {
  return area === '.' ? 'the repo root' : mdSafe(area);
}

function contextText(files, deleted, date, since) {
  const listed = files.slice(0, MAX_LISTED).map((f) => `- \`${mdSafe(f)}\`${deleted.has(f) ? ' (deleted)' : ''}`);
  if (files.length > MAX_LISTED) listed.push(`- ... and ${files.length - MAX_LISTED} more`);
  const from = since ? `changes since ${since}` : 'the working tree and the session touch list';
  return [`Captured by intent capture on ${date} from ${from}. Changed files:`, '', ...listed].join('\n');
}

function allocate(index, ns, used) {
  let n = parseInt(nextNumber(index, ns), 10);
  if (used.has(ns)) n = Math.max(n, used.get(ns) + 1);
  used.set(ns, n);
  return n;
}

// Never overwrite: if the number was taken meanwhile (another agent), take the next one.
function writeNew(ctx, ns, n, slug, render, used) {
  for (let tries = 0; tries < 50; tries++, n++) {
    const num = freeNumber(ctx.vaultDir, ns, n);
    n = parseInt(num, 10);
    const rel = recordRelPath(ns, num, slug);
    const file = join(ctx.vaultDir, rel);
    mkdirSync(dirname(file), { recursive: true });
    try {
      writeFileSync(file, render(`${ns}/${num}`), { flag: 'wx' });
      used.set(ns, n);
      return { id: `${ns}/${num}`, rel };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`could not allocate a record number in ${ns}`);
}

function appendDaily(ctx, date, proposals, touched) {
  const rel = `daily/${date}.md`;
  const file = join(ctx.vaultDir, rel);
  mkdirSync(dirname(file), { recursive: true });
  const lines = [];
  for (const p of proposals) {
    lines.push(`- Proposed ${wikilink({ id: p.id, path: p.vaultPath })} for ${areaLabel(p.area)} (${p.files.length} file${p.files.length === 1 ? '' : 's'})`);
  }
  for (const t of touched) {
    lines.push(`- Changed code governed by ${wikilink({ id: t.id, path: t.vaultPath })} (${t.files.length} file${t.files.length === 1 ? '' : 's'})`);
  }
  const body = lines.join('\n');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  // Every Stop runs capture: a section that says exactly what the last one said adds nothing.
  if (text !== null && text.trimEnd().endsWith(`## Captured by intent\n\n${body}`)) return rel;
  if (text === null) appendFileSync(file, `# ${date}\n`);
  const lead = text === null || text.endsWith('\n') ? '\n' : '\n\n';
  appendFileSync(file, `${lead}## Captured by intent\n\n${body}\n`);
  return rel;
}

export function capture(ctx, { now = new Date(), since = null, dryRun = false, extraFiles = [] } = {}) {
  checkSince(ctx, since);
  if (!dryRun) claimSession(ctx);
  const { changed, deleted, unsafe } = collect(ctx, since, extraFiles);
  const result = { changed, deleted, proposals: [], governedTouched: [], skipped: unsafe.map((path) => ({ area: null, path, reason: 'control characters in path' })), daily: null, dryRun: !!dryRun };
  if (!changed.length) return result;

  const index = loadIndex(ctx);
  const groups = new Map();
  const touched = new Map();
  for (const rel of changed) {
    const g = governing(index, ctx, rel, { isDir: false }); // collect() skipped folders already
    const at = groupOf(ctx, g, rel);
    if (!groups.has(at.key)) groups.set(at.key, { ...at, files: [], governs: new Set(), active: new Set(), proposed: new Set() });
    const grp = groups.get(at.key);
    grp.files.push(rel);
    grp.governs.add(at.glob || rel);
    for (const { record, reasons } of g.items) {
      if (!reasons.some(direct)) continue;
      if (ACTIVE.has(record.effectiveStatus)) {
        grp.active.add(record.id);
        if (!touched.has(record.id)) touched.set(record.id, { id: record.id, path: vaultPath(ctx, record.path), vaultPath: record.path, title: record.title, status: record.effectiveStatus, files: [] });
        const t = touched.get(record.id);
        if (!t.files.includes(rel)) t.files.push(rel);
      } else if (record.effectiveStatus === 'proposed') grp.proposed.add(record.id);
    }
  }

  const date = isoDate(now);
  const deletedSet = new Set(deleted);
  const used = new Map();
  const ordered = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const grp of ordered) {
    if (grp.active.size) continue; // listed in governedTouched for the agent to re-check
    if (grp.proposed.size) {
      result.skipped.push({ area: grp.area, reason: `already proposed: ${[...grp.proposed].sort().join(', ')}` });
      continue;
    }
    const ns = grp.module || 'root';
    const title = `TODO: name the decision behind the change in ${areaLabel(grp.area)}`;
    const slug = slugify(`captured ${grp.area === '.' ? 'repo root' : grp.area}`);
    const governs = [...grp.governs].sort();
    const render = (id) => renderRecord(
      { id, title, status: 'proposed', date, module: ns, governs, provenance: 'inferred-from-code', review_date: reviewDateFor(date, ctx.config.reviewMonths) },
      { context: contextText(grp.files, deletedSet, date, since), decision: TODO_DECISION },
    );
    const n = allocate(index, ns, used);
    let hit;
    if (dryRun) {
      const num = String(n).padStart(4, '0');
      hit = { id: `${ns}/${num}`, rel: recordRelPath(ns, num, slug) };
    } else hit = writeNew(ctx, ns, n, slug, render, used);
    result.proposals.push({ id: hit.id, path: vaultPath(ctx, hit.rel), vaultPath: hit.rel, area: grp.area, module: ns, governs, files: grp.files });
  }
  result.governedTouched = [...touched.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

  if (dryRun) return result;
  if (result.proposals.length || result.governedTouched.length) {
    result.daily = vaultPath(ctx, appendDaily(ctx, date, result.proposals, result.governedTouched));
  }
  clearSession(ctx);
  refresh(ctx);
  return result;
}
