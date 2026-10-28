// Intent debt: what an agent would miss or misread before changing code, as a 0-100 score (SPEC §6).

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE } from './index.mjs';
import { listFiles, listDirs } from './walk.mjs';
import { matchPath, normalizePath, isUnder } from './glob.mjs';
import { rulesStatus } from './rules.mjs';
import { isoDate } from './record.mjs';

// [findings key, points each (null = share of areas), cap], in SPEC §6 order.
export const PENALTIES = [
  ['uncoveredAreas', null, 40],
  ['drift', 3, 20],
  ['overdue', 2, 10],
  ['deadGoverns', 2, 10],
  ['staleProposed', 1, 5],
  ['missingWhy', 1, 10],
  ['unreachable', 0.5, 5],
  ['problems', 3, 10],
  ['rules', 5, 10],
];

const DRIFT_FILES = 10;
const DAY = 86400000;

export function analyze(ctx, index, { now = new Date(), lastChange = new Map(), git = true } = {}) {
  const today = isoDate(now);
  const files = listFiles(ctx);
  const matcher = patternMatcher(files);
  const active = index.records.filter((r) => ACTIVE.has(r.effectiveStatus));
  const moduleOf = new Map(index.modules.map((m) => [m.name, m]));

  const areas = codeAreas(ctx, files, index, active, matcher);
  const findings = {
    uncoveredAreas: areas.filter((a) => !a.covered).map(({ area, files: n, proposed }) => ({ area, files: n, proposed })),
    coveredAreas: areas.filter((a) => a.covered).map(({ area, files: n, records, modules }) => ({ area, files: n, records, modules })),
    drift: git ? drift(active, moduleOf, matcher, lastChange) : [],
    overdue: active.filter((r) => r.reviewDate && r.reviewDate < today).map((r) => ({ ...ref(r), reviewDate: r.reviewDate })),
    deadGoverns: deadGoverns(index, matcher),
    staleProposed: staleProposed(index, today, ctx.config.proposedMaxDays),
    missingWhy: active.filter((r) => r.missingWhy).map(ref),
    unreachable: active.filter((r) => !r.governs.length && !moduleOf.get(r.module)?.governs.length).map(ref),
    problems: index.problems.filter((p) => p.kind === 'duplicate-id' || p.kind === 'unresolved-ref'),
    // AGENTS.md is always expected; any other rules file only needs the block when it exists.
    rules: rulesStatus(ctx).filter((s) => s.broken || s.state === 'missing' || s.state === 'outdated' || (s.state === 'no-file' && s.file === 'AGENTS.md')),
    unknownStatus: index.records.filter((r) => r.effectiveStatus === 'unknown').map((r) => ({ id: r.id, path: r.path, statusRaw: r.statusRaw })),
  };

  const penalties = PENALTIES.map(([kind, each, cap]) => {
    const count = findings[kind].length;
    const raw = each === null ? (areas.length ? (cap * count) / areas.length : 0) : Math.min(cap, count * each);
    return { kind, count, penalty: raw, cap, each };
  });
  // Round once at the end so fractional penalties (areas, 0.5 each) do not drift the total.
  const lost = penalties.reduce((s, p) => s + p.penalty, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - lost)));
  for (const p of penalties) p.penalty = Math.round(p.penalty * 100) / 100;

  return {
    score,
    date: today,
    driftChecked: Boolean(git),
    penalties,
    findings,
    totals: { records: index.records.length, active: active.length, modules: index.modules.length, areas: areas.length },
  };
}

function ref(r) {
  return { id: r.id, path: r.path, module: r.module };
}

// Files matched by a governs pattern, computed once per pattern.
function patternMatcher(files) {
  const cache = new Map();
  return (pattern) => {
    if (!cache.has(pattern)) cache.set(pattern, files.filter((f) => matchPath(pattern, f)));
    return cache.get(pattern);
  };
}

// The folders areaDepth levels below each code root. A folder with no sub-folders stops the descent.
export function areaFolders(ctx) {
  const d = Number(ctx.config.areaDepth);
  const depth = Number.isInteger(d) && d >= 0 ? d : 1;
  const out = new Set();
  const below = (dir, left) => {
    const subs = left > 0 ? listDirs(ctx, dir) : [];
    if (!subs.length) { out.add(dir); return; }
    for (const s of subs) below(s, left - 1);
  };
  for (const raw of ctx.config.codeRoots || []) {
    const dir = normalizePath(raw).replace(/\/$/, '').replace(/^\.$/, '');
    if (dir.startsWith('..') || !isDir(join(ctx.root, dir))) continue;
    below(dir, depth);
  }
  return [...out].sort();
}

function isDir(p) {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}

// Mentions in a body are hints, not coverage: only governs patterns of active records and module notes count.
function codeAreas(ctx, files, index, active, matcher) {
  const out = [];
  for (const area of areaFolders(ctx)) {
    const inArea = new Set(files.filter((f) => isUnder(f, area)));
    if (!inArea.size) continue;
    const hits = (g) => matcher(g).some((f) => inArea.has(f));
    const records = active.filter((r) => r.governs.some(hits)).map((r) => r.id);
    const modules = index.modules.filter((m) => m.governs.some(hits)).map((m) => m.name);
    // Not coverage yet, but the fix is to confirm them rather than to write another record.
    const proposed = index.records.filter((r) => r.effectiveStatus === 'proposed' && r.governs.some(hits)).map((r) => r.id);
    out.push({ area, files: inArea.size, covered: records.length > 0 || modules.length > 0, records, modules, proposed });
  }
  return out;
}

// Governed files whose last commit is after the record date. Records without governs
// fall back to their module note, since that is what points an agent at them.
function drift(active, moduleOf, matcher, lastChange) {
  const out = [];
  for (const r of active) {
    if (!r.date) continue;
    const patterns = r.governs.length ? r.governs : moduleOf.get(r.module)?.governs || [];
    const seen = new Set();
    const changed = [];
    for (const g of patterns) {
      for (const file of matcher(g)) {
        if (seen.has(file)) continue;
        seen.add(file);
        const at = lastChange.get(file);
        if (at && at > r.date) changed.push({ file, changed: at });
      }
    }
    if (!changed.length) continue;
    changed.sort((a, b) => (a.changed < b.changed ? 1 : a.changed > b.changed ? -1 : a.file < b.file ? -1 : 1));
    out.push({ ...ref(r), date: r.date, total: changed.length, files: changed.slice(0, DRIFT_FILES) });
  }
  return out;
}

// Superseded and deprecated records are history: their governs may name code that is gone.
function deadGoverns(index, matcher) {
  const out = [];
  for (const r of index.records) {
    if (!ACTIVE.has(r.effectiveStatus) && r.effectiveStatus !== 'proposed') continue;
    for (const pattern of new Set(r.governs)) {
      if (!matcher(pattern).length) out.push({ ...ref(r), pattern });
    }
  }
  for (const m of index.modules) {
    for (const pattern of new Set(m.governs)) {
      if (!matcher(pattern).length) out.push({ module: m.name, pattern, path: m.path });
    }
  }
  return out;
}

function staleProposed(index, today, maxDays) {
  const limit = Number.isFinite(Number(maxDays)) ? Number(maxDays) : 14;
  const out = [];
  for (const r of index.records) {
    if (r.effectiveStatus !== 'proposed' || !r.date) continue;
    const days = Math.floor((Date.parse(today) - Date.parse(r.date)) / DAY);
    if (days > limit) out.push({ ...ref(r), date: r.date, days });
  }
  return out;
}
