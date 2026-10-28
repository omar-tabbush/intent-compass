// intent capture: draft proposed records for changed code that no decision governs.

import { loadContext } from '../config.mjs';
import { areaLabel, capture } from '../capture.mjs';
import { notOptedIn } from './_shared.mjs';

const MAX_FILES_SHOWN = 5;

export async function run({ flags }, io) {
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  if (flags.since === true || flags.since === '') { io.err('intent capture: --since needs a git ref'); return 1; }
  let res;
  try {
    res = capture(ctx, { now: io.now, since: flags.since || null, dryRun: !!flags['dry-run'] });
  } catch (e) {
    io.err(`intent capture: ${e.message}`);
    return 1;
  }
  if (flags.json) { io.out(JSON.stringify(res, null, 2)); return 0; }
  for (const line of report(res)) io.out(line);
  return 0;
}

function fileList(files) {
  const shown = files.slice(0, MAX_FILES_SHOWN).join(', ');
  return files.length > MAX_FILES_SHOWN ? `${shown}, ... and ${files.length - MAX_FILES_SHOWN} more` : shown;
}

function report(res) {
  if (!res.changed.length) return ['Nothing to capture.'];
  const out = [];
  if (res.proposals.length) {
    out.push(`${res.dryRun ? 'Would propose' : 'Proposed'} ${res.proposals.length} record(s) for changed code with no recorded intent (Why left as TODO):`);
    for (const p of res.proposals) out.push(`  ${p.id}  ${p.path}  (${areaLabel(p.area)}: ${fileList(p.files)})`);
  }
  if (res.governedTouched.length) {
    out.push('Changed code is governed by these records; re-check that the change still follows them:');
    for (const t of res.governedTouched) out.push(`  ${t.id} (${t.status})  ${t.path}  (${fileList(t.files)})`);
  }
  if (res.skipped.length) {
    out.push('Skipped:');
    for (const s of res.skipped) out.push(`  ${areaLabel(s.area)}: ${s.reason}`);
  }
  if (res.dryRun) out.push('Dry run: nothing written.');
  else if (res.proposals.length) out.push('Fill each Why only from what the user said; then ask the user to run: intent accept <id>');
  return out;
}
