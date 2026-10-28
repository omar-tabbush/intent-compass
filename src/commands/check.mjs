// intent check: the intent-debt report and its 0-100 score. Read-only: it writes nothing.

import { loadContext, vaultPath } from '../config.mjs';
import { loadIndex } from '../index.mjs';
import { isGitRepo, lastChangeMap } from '../git.mjs';
import { validModuleName } from '../ids.mjs';
import { analyze } from '../check.mjs';
import { notOptedIn } from './_shared.mjs';

const SECTION_LINES = 20;

const LABELS = {
  uncoveredAreas: 'Uncovered code areas',
  drift: 'Drift (governed files changed after the record date)',
  overdue: 'Overdue reviews',
  deadGoverns: 'Dead governs (match no file)',
  staleProposed: 'Stale proposals',
  missingWhy: 'Active records with no why',
  unreachable: 'Unreachable records (nothing points an agent at them)',
  problems: 'Duplicate IDs / unresolved supersedes',
  rules: 'Rules block missing or outdated',
};

export async function run({ flags }, io) {
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  const min = parseMin(flags.min);
  if (min === false) {
    io.err('intent check: --min needs a number from 0 to 100.');
    return 2;
  }
  const git = isGitRepo(ctx.root);
  const report = analyze(ctx, loadIndex(ctx), { now: io.now, lastChange: git ? lastChangeMap(ctx.root) : new Map(), git });
  if (flags.json) io.out(JSON.stringify(report, null, 2));
  else for (const line of render(report, ctx)) io.out(line);
  return min !== null && report.score < min ? 1 : 0;
}

// null when absent, false when unusable.
function parseMin(v) {
  if (v === undefined) return null;
  const n = Number(v);
  return v !== true && String(v).trim() !== '' && Number.isFinite(n) ? n : false;
}

export function render(report, ctx) {
  const { findings: f, totals: t } = report;
  const vp = (p) => vaultPath(ctx, p);
  const lines = [`Intent debt: ${report.score}/100`];
  lines.push(`${plural(t.records, 'record', 'records')} (${t.active} active), ${plural(t.modules, 'module', 'modules')}, ${t.areas - f.uncoveredAreas.length} of ${t.areas} code areas covered.`);
  if (!report.driftChecked) lines.push('Drift not checked: not a git repo.');

  const hit = report.penalties.filter((p) => p.count > 0);
  if (hit.length) {
    lines.push('');
    for (const p of hit) {
      const count = p.kind === 'uncoveredAreas' ? `${p.count} of ${t.areas}` : String(p.count);
      const capped = p.each !== null && p.count * p.each > p.cap ? ', capped' : '';
      lines.push(`  ${LABELS[p.kind]}: ${count} (-${points(p.penalty)}${capped})`);
    }
  }

  section(lines, LABELS.uncoveredAreas, f.uncoveredAreas, (a) => `${a.area} (${a.files} ${a.files === 1 ? 'file' : 'files'}${a.proposed.length ? `; waiting for intent accept: ${a.proposed.join(', ')}` : ''})`);
  section(lines, LABELS.drift, f.drift, (d) => `${d.id} (${d.date}): ${d.total} changed since, latest ${d.files[0].file} on ${d.files[0].changed}`);
  section(lines, LABELS.overdue, f.overdue, (r) => `${r.id}: review was due ${r.reviewDate}`);
  section(lines, LABELS.deadGoverns, f.deadGoverns, (d) => `${d.id || `module ${d.module}`}: ${d.pattern} (${vp(d.path)})`);
  section(lines, LABELS.staleProposed, f.staleProposed, (r) => `${r.id}: proposed ${r.days} days ago (${r.date})`);
  section(lines, LABELS.missingWhy, f.missingWhy, (r) => `${r.id} (${vp(r.path)})`);
  section(lines, LABELS.unreachable, f.unreachable, (r) => `${r.id} (${vp(r.path)})`);
  section(lines, LABELS.problems, f.problems, (p) => `${p.kind}: ${p.message} (${problemPaths(ctx, p)})`);
  section(lines, LABELS.rules, f.rules, (s) => `${s.file}: ${s.broken ? `broken markers (${s.broken}), fix them by hand` : s.state === 'no-file' ? 'file missing' : `block ${s.state}`}`);
  section(lines, 'Unknown status (counted as active)', f.unknownStatus, (r) => `${r.id}: status "${r.statusRaw}"`);

  lines.push('', hint(report, ctx));
  return lines;
}

function section(lines, title, items, fmt) {
  if (!items.length) return;
  lines.push('', `${title}:`);
  for (const it of items.slice(0, SECTION_LINES)) lines.push(`  ${fmt(it)}`);
  if (items.length > SECTION_LINES) lines.push(`  ... and ${items.length - SECTION_LINES} more`);
}

function points(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// The single next step that recovers the most points. Ties go to the earlier row of the table.
function hint(report, ctx) {
  const top = report.penalties.reduce((best, p) => (p.penalty > (best ? best.penalty : 0) ? p : best), null);
  if (!top) return 'No intent debt found.';
  const first = report.findings[top.kind][0];
  const gap = (one, many) => `Biggest gap: ${plural(top.count, one, many)}.`;
  // Accepted records are never edited: a fix to one is a new record that supersedes it.
  const supersede = (r, extra = '') => `intent new ${moduleArg(r.module)} "<the rule>" --supersedes ${r.id}${extra}`;
  switch (top.kind) {
    case 'uncoveredAreas': {
      const waiting = report.findings.uncoveredAreas.find((a) => a.proposed.length);
      if (waiting) return `${gap('uncovered area', 'uncovered areas')} ${waiting.area} has a proposal waiting: ask the human to confirm it, then: intent accept ${waiting.proposed[0]}`;
      return `${gap('uncovered area', 'uncovered areas')} Record intent: intent new ${moduleArg(first.area.split('/').at(-1))} "<the rule>" --governs ${first.area}/**`;
    }
    case 'drift':
      return `${gap('drifted record', 'drifted records')} Re-read ${first.id} against its changed files; if it no longer holds: ${supersede(first)}`;
    case 'overdue':
      return `${gap('overdue review', 'overdue reviews')} Re-read ${first.id}; if it no longer holds: ${supersede(first)}`;
    case 'deadGoverns':
      return first.module && !first.id
        ? `${gap('dead governs pattern', 'dead governs patterns')} Point ${first.pattern} in ${vaultPath(ctx, first.path)} at code that exists.`
        : `${gap('dead governs pattern', 'dead governs patterns')} ${first.id} governs ${first.pattern}, which matches no file. If the code moved: ${supersede(first, ' --governs <new paths>')}`;
    case 'staleProposed':
      return `${gap('stale proposal', 'stale proposals')} Ask the human to confirm, then: intent accept ${first.id}`;
    case 'missingWhy':
      return `${gap('record has no why', 'records have no why')} Ask the human why (do not guess), then: ${supersede(first, ' --why "<their words>"')}`;
    case 'unreachable':
      return first.module === 'root'
        ? `${gap('unreachable record', 'unreachable records')} Point agents at ${first.id}: ${supersede(first, ' --governs <paths>')}`
        : `${gap('unreachable record', 'unreachable records')} Add governs to ${vaultPath(ctx, `modules/${first.module}/${first.module}.md`)} so agents are pointed at ${first.id}.`;
    case 'problems':
      return `${gap('ID problem', 'ID problems')} ${first.message} (${problemPaths(ctx, first)}). Fix the files, then run: intent index`;
    default:
      return first.broken
        ? `${gap('rules file needs the block', 'rules files need the block')} Fix the intent-compass markers in ${first.file} by hand, then run: intent rules`
        : `${gap('rules file needs the block', 'rules files need the block')} Run: intent rules`;
  }
}

function moduleArg(name) {
  return validModuleName(name) ? name : '<module>';
}

// A problem's files as a reader opens them; a duplicate-id problem has several.
function problemPaths(ctx, p) {
  return (p.paths || [p.path]).map((x) => vaultPath(ctx, x)).join(', ');
}
