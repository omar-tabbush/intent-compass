// intent rules: write or refresh the agent rules block in each rulesFiles entry, or --check it.

import { loadContext } from '../config.mjs';
import { applyRules, brokenMarkers, rulesStatus } from '../rules.mjs';
import { notOptedIn } from './_shared.mjs';

export { brokenMarkers };

const USAGE = 'usage: intent rules [--check] [--create] [--json]';
const NO_FILE = 'file does not exist; create it or pass --create';

// The core refuses a file with broken markers (applyRules skips it with broken set).
function apply(ctx, create) {
  return applyRules(ctx, { create }).map(({ file, action, broken }) => ({
    file,
    action,
    reason: broken ? `broken markers: ${broken}; fix them by hand` : action === 'skipped' ? NO_FILE : null,
  }));
}

// AGENTS.md is always expected; any other rules file only needs the block when it exists.
const passes = (s) => s.state === 'ok' || (s.state === 'no-file' && s.file !== 'AGENTS.md');

const STATE_TEXT = {
  ok: 'ok',
  outdated: 'outdated (block text or hash differs from this version)',
  missing: 'missing (file has no rules block)',
};

function stateLine(s) {
  const text = s.state === 'no-file' ? (s.ok ? 'no file (optional)' : 'no file') : STATE_TEXT[s.state] || s.state;
  return `${s.file}: ${text}${s.broken ? `; broken markers: ${s.broken}, fix them by hand` : ''}`;
}

function check(ctx) {
  return rulesStatus(ctx).map((s) => ({ file: s.file, state: s.state, ok: passes(s) && !s.broken, broken: s.broken || null }));
}

function runCheck(ctx, flags, io) {
  const results = check(ctx);
  const ok = results.every((r) => r.ok);
  if (flags.json) { io.out(JSON.stringify({ ok, files: results }, null, 2)); return ok ? 0 : 1; }
  if (!results.length) io.out('No rules files configured (rulesFiles in .intent.json is empty).');
  for (const r of results) io.out(stateLine(r));
  if (!ok) io.out('Run: intent rules');
  return ok ? 0 : 1;
}

function runApply(ctx, flags, io) {
  const results = apply(ctx, !!flags.create);
  // A refused file needs a human; a missing optional file does not.
  const code = results.some((r) => r.action === 'skipped' && r.reason !== NO_FILE) ? 1 : 0;
  if (flags.json) { io.out(JSON.stringify({ files: results }, null, 2)); return code; }
  if (!results.length) io.out('No rules files configured (rulesFiles in .intent.json is empty).');
  for (const r of results) io.out(`${r.file}: ${r.action}${r.reason ? ` (${r.reason})` : ''}`);
  return code;
}

export async function run({ positional, flags }, io) {
  if (positional.length) { io.err(USAGE); return 2; }
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  try {
    return flags.check ? runCheck(ctx, flags, io) : runApply(ctx, flags, io);
  } catch (e) {
    io.err(`intent rules: ${e.message}`);
    return 1;
  }
}
