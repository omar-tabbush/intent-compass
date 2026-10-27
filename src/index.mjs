// The derived index: records with resolved supersede links and effective status,
// modules with their decisions, and the lookup behind `intent why`.

import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadVault } from './vault.mjs';
import { matchPath, isUnder, normalizePath, globBase, hasGlob } from './glob.mjs';
import { listFiles } from './walk.mjs';
import { unwiki } from './fm.mjs';

export const ACTIVE = new Set(['accepted', 'unknown']);
const RANK = { accepted: 0, unknown: 1, proposed: 2, superseded: 3, deprecated: 4 };

export function buildIndex(vault) {
  const records = vault.records.map((r) => ({ ...r }));
  records.sort((a, b) => cmp(a.id, b.id) || cmp(a.path, b.path));
  const problems = [...vault.problems];

  const byId = new Map();
  const byBase = new Map();
  for (const r of records) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
    const base = r.path.split('/').at(-1).replace(/\.md$/i, '').toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(r);
  }
  for (const [id, rs] of byId) {
    if (rs.length > 1) {
      problems.push({ kind: 'duplicate-id', path: rs.map((r) => r.path).join(', '), message: `ID ${id} is used by ${rs.length} records` });
    }
  }

  const resolve = (raw, from) => {
    let s = unwiki(String(raw)).replace(/\.md$/i, '').replace(/^\.\.?\//, '').trim();
    while (s.startsWith('../')) s = s.slice(3);
    if (!s) return null;
    const spaced = s.match(/^([\w-]+)\s+(\d+)$/); // "root 0043", "billing 0009"
    if (spaced) s = `${spaced[1]}/${spaced[2].padStart(4, '0')}`;
    if (byId.has(s)) return pick(byId.get(s), from).id;
    const base = s.split('/').at(-1).toLowerCase();
    if (/^\d+$/.test(base)) {
      const segs = s.split('/');
      const ns = segs.length >= 2 && segs.at(-2) !== 'decisions' ? segs.at(-2) : segs.includes('modules') ? segs[segs.indexOf('modules') + 1] : segs.includes('decisions') ? 'root' : from.ns;
      const id = `${ns}/${base.padStart(4, '0')}`;
      if (byId.has(id)) return pick(byId.get(id), from).id;
    }
    if (byBase.has(base)) {
      const cands = byBase.get(base);
      const ns = s.includes('modules/') ? s.split('modules/')[1].split('/')[0] : s.includes('decisions/') && !s.includes('modules/') && s.split('/').length <= 2 ? 'root' : null;
      const hit = (ns && cands.find((c) => c.ns === ns)) || pick(cands, from);
      return hit.id;
    }
    const lead = base.match(/^(\d+)-/);
    if (lead) {
      const id = `${from.ns}/${lead[1]}`;
      if (byId.has(id)) return id;
    }
    return null;
  };

  for (const r of records) {
    r.supersedes = [];
    r.supersededBy = [];
    r.pendingReplacements = [];
  }
  for (const r of records) {
    for (const raw of r.supersedesRaw) {
      const id = resolve(raw, r);
      if (id && id !== r.id) r.supersedes.push(id);
      else problems.push({ kind: 'unresolved-ref', path: r.path, message: `supersedes "${raw}" does not match any record` });
    }
    r.declaredSupersededBy = [];
    for (const raw of r.supersededByRaw) {
      const id = resolve(raw, r);
      if (id && id !== r.id) r.declaredSupersededBy.push(id);
      else problems.push({ kind: 'unresolved-ref', path: r.path, message: `superseded-by "${raw}" does not match any record` });
    }
  }
  for (const r of records) {
    for (const t of r.supersedes) {
      for (const target of byId.get(t) || []) {
        if (ACTIVE.has(r.status)) add(target.supersededBy, r.id);
        else if (r.status === 'proposed') add(target.pendingReplacements, r.id);
      }
    }
    for (const t of r.declaredSupersededBy) add(r.supersededBy, t);
  }
  for (const r of records) {
    r.effectiveStatus = r.supersededBy.length && r.status !== 'deprecated' ? 'superseded' : r.status;
    delete r.supersedesRaw;
    delete r.supersededByRaw;
    delete r.declaredSupersededBy;
    r.supersedes.sort(); r.supersededBy.sort(); r.pendingReplacements.sort();
  }

  const modules = vault.modules
    .map((m) => ({ ...m, decisions: records.filter((r) => r.module === m.name).map((r) => r.id) }))
    .sort((a, b) => cmp(a.name, b.name));

  problems.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.path, b.path) || cmp(a.message, b.message));
  return { version: 1, records, modules, problems };
}

function pick(cands, from) {
  return cands.find((c) => c.ns === from.ns) || cands[0];
}

function add(arr, v) {
  if (!arr.includes(v)) arr.push(v);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function loadIndex(ctx) {
  return buildIndex(loadVault(ctx));
}

export function writeIndex(ctx, index) {
  mkdirSync(ctx.vaultDir, { recursive: true });
  const file = join(ctx.vaultDir, 'index.json');
  writeFileSync(file, JSON.stringify(index, null, 2) + '\n');
  return file;
}

export function rankOf(r) {
  return RANK[r.effectiveStatus] ?? 5;
}

// What governs a repo-relative path. A folder is governed by anything that governs
// a file inside it, or whose glob reaches into it.
export function governing(index, ctx, relPath, { files } = {}) {
  const path = normalizePath(relPath).replace(/\/$/, '');
  let isDir = false;
  try { isDir = existsSync(join(ctx.root, path)) && statSync(join(ctx.root, path)).isDirectory(); } catch { /* treat as file */ }
  if (path === '') isDir = true;
  const inDir = isDir ? (files || listFiles(ctx, path)) : null;

  const hits = (pattern) => {
    if (matchPath(pattern, path)) return true;
    if (!isDir) return false;
    const base = globBase(pattern);
    if (base && isUnder(base, path) && (!hasGlob(pattern) || base !== path)) return true;
    return inDir.some((f) => matchPath(pattern, f));
  };

  const items = new Map();
  const note = (record, reason) => {
    if (!items.has(record.id + '\0' + record.path)) items.set(record.id + '\0' + record.path, { record, reasons: [] });
    const it = items.get(record.id + '\0' + record.path);
    if (!it.reasons.includes(reason)) it.reasons.push(reason);
  };

  for (const r of index.records) {
    for (const g of r.governs) if (hits(g)) note(r, `governs ${g}`);
  }
  const modules = [];
  for (const m of index.modules) {
    const g = m.governs.find(hits);
    if (!g) continue;
    modules.push({ module: m, reason: `module ${m.name} governs ${g}` });
    for (const r of index.records) if (r.module === m.name) note(r, `in module ${m.name}`);
  }
  for (const r of index.records) {
    for (const ref of r.refs) {
      const refPath = ref.replace(/\/$/, '');
      if (refPath === path || isUnder(path, refPath) || (isDir && isUnder(refPath, path))) note(r, `mentions ${ref}`);
    }
  }

  const strength = (it) => (it.reasons.some((x) => x.startsWith('governs')) ? 0 : it.reasons.some((x) => x.startsWith('in module')) ? 1 : 2);
  const list = [...items.values()].sort(
    (a, b) => rankOf(a.record) - rankOf(b.record) || strength(a) - strength(b) || cmp(a.record.id, b.record.id),
  );
  return { path, isDir, items: list, modules };
}
