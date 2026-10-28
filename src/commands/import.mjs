// intent import SRC [--dry-run] [--json]: copy records and module notes from an
// Obsidian-style vault into this vault. The source is only read.

import { resolve } from 'node:path';
import { loadContext } from '../config.mjs';
import { importReport, importVault, ungovernedModules } from '../importer.mjs';
import { notOptedIn, refresh } from './_shared.mjs';

export async function run({ positional, flags }, io) {
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  const srcArg = positional[0];
  if (!srcArg) {
    io.err('intent import: give the folder to import from: intent import SRC [--dry-run] [--json]');
    return 1;
  }
  const dryRun = Boolean(flags['dry-run']);
  let result;
  try {
    result = importVault(ctx, resolve(io.cwd, srcArg), { now: io.now, dryRun });
  } catch (e) {
    io.err(`intent import: ${e.message}`);
    return 1;
  }
  const index = dryRun ? null : refresh(ctx);
  const vault = ctx.vaultInRepo ? ctx.vaultRel : ctx.vaultDir;
  if (flags.json) {
    io.out(JSON.stringify({
      ...result,
      vault,
      ungoverned: ungovernedModules(result, index),
      problems: index ? index.problems : [],
    }, null, 2));
    return 0;
  }
  for (const line of importReport(result, { source: srcArg, vault, index })) io.out(line);
  return 0;
}
