// The derived index: records with resolved supersede links and effective status,
// modules with their decisions, and the lookup behind `intent why`.

import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadVault } from './vault.mjs';
import { matchPath, isUnder, normalizePath, globBase, hasGlob } from './glob.mjs';
import { listFiles } from './walk.mjs';
import { unwiki } from './fm.mjs';
import { syncGenerated } from './generated.mjs';

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
      problems.push({ kind: 'duplicate-id', path: rs.map((r) => r.path).join(', '), paths: rs.map((r) => r.path), message: `ID ${id} is used by ${rs.length} records` });
    }
  }

  const byIdLower = new Map();
  for (const id of byId.keys()) if (!byIdLower.has(id.toLowerCase())) byIdLower.set(id.toLowerCase(), id);
  const idHit = (id) => {
    const real = byId.has(id) ? id : byIdLower.get(id.toLowerCase());
    return real ? { id: real, targets: byId.get(real) } : null;
  };

  // The namespace a ref's folders name: modules/<m>/… -> m, decisions/… -> root (any case).
  // undefined when the ref has no folder, null when its folders name neither.
  const pathNs = (segs) => {
    if (segs.length < 2) return undefined;
    const low = segs.map((x) => x.toLowerCase());
    const mi = low.indexOf('modules');
    if (mi !== -1 && mi + 1 < segs.length - 1) return segs[mi + 1];
    if (low.includes('decisions') && segs.length <= 2) return 'root';
    return null;
  };

  // One cleaned ref -> { id, targets: [records] } or null. A bare id or number names every record
  // with that id; a file name or path names that one file.
  const resolveOne = (raw, from) => {
    let s = raw.replace(/\.md$/i, '').replace(/^\.\.?\//, '').trim();
    while (s.startsWith('../')) s = s.slice(3);
    if (!s) return null;
    const spaced = s.match(/^([\w-]+)\s+(\d+)$/); // "root 0043", "billing 0009"
    if (spaced) s = `${spaced[1]}/${spaced[2].padStart(4, '0')}`;
    if (byId.has(s)) return idHit(s);
    const segs = s.split('/');
    const low = segs.map((x) => x.toLowerCase());
    const base = low.at(-1);
    if (/^\d+$/.test(base)) {
      const ns = segs.length >= 2 && low.at(-2) !== 'decisions' ? segs.at(-2)
        : low.includes('modules') ? segs[low.indexOf('modules') + 1]
          : low.includes('decisions') ? 'root' : from.ns;
      return idHit(`${ns}/${base.padStart(4, '0')}`);
    }
    const ns = pathNs(segs);
    if (byBase.has(base)) {
      const cands = byBase.get(base);
      const hit = ns ? cands.find((c) => c.ns.toLowerCase() === ns.toLowerCase()) : ns === undefined ? pick(cands, from) : null;
      if (hit) return { id: hit.id, targets: [hit] };
    }
    // "0005-some-title" whose title no file matches: the record with that number, in the
    // namespace the ref's folders name, or the referring record's own when it names none.
    const lead = base.match(/^(\d+)-/);
    if (lead && ns !== null) return idHit(`${ns === undefined ? from.ns : ns}/${lead[1].padStart(4, '0')}`);
    return null;
  };

  // Try the ref as written, then without a trailing qualifier ("(the pdf part)", "— only X").
  const resolve = (raw, from) => {
    const full = unwiki(String(raw)).trim();
    const cut = full.replace(/\s*(?:\(|—|–|\s-\s).*$/, '').trim();
    const token = full.split(/\s+/)[0];
    for (const s of new Set([full, cut, token])) {
      const hit = s ? resolveOne(s, from) : null;
      if (hit) return hit;
    }
    return null;
  };

  for (const r of records) {
    r.supersedes = [];
    r.supersededBy = [];
    r.pendingReplacements = [];
    r.supersedeTargets = [];
  }
  for (const r of records) {
    for (const raw of r.supersedesRaw) {
      const hit = resolve(raw, r);
      const targets = hit ? hit.targets.filter((t) => t !== r) : [];
      if (targets.length) { add(r.supersedes, hit.id); for (const t of targets) add(r.supersedeTargets, t); }
      else problems.push({ kind: 'unresolved-ref', path: r.path, message: `supersedes "${raw}" does not match any record` });
    }
    r.declaredSupersededBy = [];
    for (const raw of r.supersededByRaw) {
      const hit = resolve(raw, r);
      if (hit && hit.id !== r.id) r.declaredSupersededBy.push(hit.id);
      else problems.push({ kind: 'unresolved-ref', path: r.path, message: `superseded-by "${raw}" does not match any record` });
    }
  }
  for (const r of records) {
    for (const target of r.supersedeTargets) {
      if (ACTIVE.has(r.status)) add(target.supersededBy, r.id);
      else if (r.status === 'proposed') add(target.pendingReplacements, r.id);
    }
    for (const t of r.declaredSupersededBy) add(r.supersededBy, t);
  }
  for (const r of records) {
    r.effectiveStatus = r.supersededBy.length && r.status !== 'deprecated' ? 'superseded' : r.status;
    delete r.supersedesRaw;
    delete r.supersededByRaw;
    delete r.declaredSupersededBy;
    delete r.supersedeTargets;
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

// True when file is missing or holds an index this tool wrote (a damaged copy, such as one with
// merge-conflict markers, included). A vault folder may already have an index.json of its own.
export function indexWritable(file) {
  if (!existsSync(file)) return true;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return false; }
  try {
    const d = JSON.parse(text);
    return d !== null && typeof d === 'object' && d.version === 1 && Array.isArray(d.records);
  } catch {
    return /"records"\s*:/.test(text);
  }
}

export function writeIndex(ctx, index) {
  const file = join(ctx.vaultDir, 'index.json');
  if (!indexWritable(file)) throw new Error(`${file} exists and is not an intent index; move it away`);
  mkdirSync(ctx.vaultDir, { recursive: true });
  writeFileSync(file, JSON.stringify(index, null, 2) + '\n');
  return file;
}

// After writing records: rebuild the index and generated regions from the files.
export function refresh(ctx) {
  const index = loadIndex(ctx);
  syncGenerated(ctx, index); // first: it adds broken-markers problems to the index
  writeIndex(ctx, index);
  return index;
}

export function rankOf(r) {
  return RANK[r.effectiveStatus] ?? 5;
}

// What governs a repo-relative path. A folder is governed by anything that governs
// a file inside it, or whose glob reaches into it.
// isDir: pass false when the caller already knows the path is a file (capture), to skip a stat per file.
export function governing(index, ctx, relPath, { files, isDir: knownDir } = {}) {
  const path = normalizePath(relPath).replace(/\/$/, '');
  let isDir = false;
  if (typeof knownDir === 'boolean') isDir = knownDir;
  else try { isDir = existsSync(join(ctx.root, path)) && statSync(join(ctx.root, path)).isDirectory(); } catch { /* treat as file */ }
  if (path === '') isDir = true;
  const inDir = isDir ? (files || listFiles(ctx, path)) : null;

  const hits = (pattern) => {
    // "src/a/*" names the folder src/a/deep but governs no file in it.
    const np = normalizePath(pattern);
    if (matchPath(pattern, path) && (!isDir || !hasGlob(np) || np.endsWith('/**') || np.endsWith('/'))) return true;
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

// A mention of a whole code root (or a folder no deeper than an area) in a record's body is a
// pointer, not governance: it would put that record in front of every edit under the folder.
export function shallowMention(ctx, reasons) {
  if (!reasons.every((r) => r.startsWith('mentions '))) return false;
  const roots = new Set((ctx.config.codeRoots || []).map((c) => String(c).replace(/\/$/, '')));
  const depth = Number.isInteger(Number(ctx.config.areaDepth)) ? Number(ctx.config.areaDepth) : 1;
  return reasons.every((r) => {
    const ref = r.slice('mentions '.length);
    if (!ref.endsWith('/')) return false;
    const dir = ref.replace(/\/$/, '');
    return roots.has(dir) || dir.split('/').length <= Math.max(1, depth);
  });
}
