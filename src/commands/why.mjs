// intent why: the records and module notes that govern a path, active first, and the files to read.

import { isAbsolute } from 'node:path';
import { loadContext, vaultPath, vaultWarning } from '../config.mjs';
import { loadIndex, governing, shallowMention, ACTIVE } from '../index.mjs';
import { usageOf } from '../cli.mjs';
import { notOptedIn } from './_shared.mjs';

function outside(rel) {
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

const mentionOnly = (reasons) => reasons.every((r) => r.startsWith('mentions '));

function describe(ctx, g) {
  const modules = g.modules.map(({ module: m, reason }) => ({
    name: m.name,
    path: vaultPath(ctx, m.path),
    governs: m.governs,
    reason,
  }));
  const pointerOnly = new Set(g.items.filter((it) => shallowMention(ctx, it.reasons)).map((it) => it.record));
  const records = g.items.map(({ record: r, reasons }) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    effectiveStatus: r.effectiveStatus,
    path: vaultPath(ctx, r.path),
    reasons,
    missingWhy: r.missingWhy,
    supersededBy: r.supersededBy,
    pendingReplacements: r.pendingReplacements,
    pointer: pointerOnly.has(r),
  }));
  const read = [...new Set([
    ...records.filter((r) => ACTIVE.has(r.effectiveStatus) && !r.pointer).map((r) => r.path),
    ...modules.map((m) => m.path),
  ])];
  return { path: g.path, isDir: g.isDir, modules, records, read };
}

function notes(r) {
  const out = [];
  if (r.effectiveStatus === 'superseded' && r.supersededBy.length) out.push(`superseded by ${r.supersededBy.join(', ')}`);
  if (r.effectiveStatus === 'proposed') out.push('proposed, not yet confirmed');
  if (r.pendingReplacements.length) out.push(`replacement proposed: ${r.pendingReplacements.join(', ')}`);
  if (r.missingWhy) out.push('why not recorded');
  return out.map((n) => ` (${n})`).join('');
}

function reasonLine(r) {
  if (mentionOnly(r.reasons)) return `mentioned in this record only (weaker than governs): ${r.reasons.map((x) => x.slice(9)).join(', ')}`;
  return r.reasons.join(' · ');
}

const hint = (d) => {
  const waiting = d.records.find((r) => r.effectiveStatus === 'proposed');
  if (waiting) return `Proposed records are waiting: ask the user to confirm one with intent accept ${waiting.id} before you write a new one.`;
  return `If you make a load-bearing choice here, record it: intent new <module> "<rule>" --governs ${d.path || '.'}`;
};

function printHuman(io, d) {
  const shown = d.path === '' ? '.' : d.isDir ? `${d.path}/` : d.path;
  if (!d.modules.length && !d.records.length) {
    io.out(`No recorded intent for ${shown}.`);
    io.out(hint(d));
    return;
  }
  io.out(shown);
  for (const m of d.modules) {
    io.out(`  module ${m.name}  (${m.path})  governs ${m.reason.slice(`module ${m.name} governs `.length)}`);
  }
  for (const r of d.records) {
    io.out(`  ${r.effectiveStatus.padEnd(12)}${r.id}  ${r.title}${notes(r)}`);
    // A record not in the read list (proposed, superseded, a mere pointer) still shows its file.
    io.out(`  ${' '.repeat(12)}${reasonLine(r)}${d.read.includes(r.path) ? '' : `  (${r.path})`}`);
  }
  if (d.read.length) {
    io.out('Read before editing:');
    for (const p of d.read) io.out(`  ${p}`);
  } else {
    io.out(`No active record governs ${shown}.`);
    io.out(hint(d));
  }
}

export async function run({ positional, flags }, io) {
  if (!positional.length) { io.err(usageOf('why')); return 2; }
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  const warning = vaultWarning(ctx);
  if (warning) io.err(warning);
  const index = loadIndex(ctx);
  let code = 0;
  const results = [];
  for (const p of positional) {
    const rel = ctx.rel(p, io.cwd);
    if (outside(rel)) { io.err(`intent: ${p} is outside the repo (${ctx.root})`); code = 1; continue; }
    results.push(describe(ctx, governing(index, ctx, rel)));
  }
  if (flags.json) { io.out(JSON.stringify({ paths: results }, null, 2)); return code; }
  results.forEach((d, i) => { if (i) io.out(''); printHuman(io, d); });
  return code;
}
