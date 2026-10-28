// intent index: rebuild index.json and the generated regions from the files.

import { loadContext, vaultWarning } from '../config.mjs';
import { loadIndex, writeIndex } from '../index.mjs';
import { syncGenerated } from '../generated.mjs';
import { notOptedIn } from './_shared.mjs';

export async function run(_args, io) {
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  const warning = vaultWarning(ctx);
  if (warning) io.err(warning);
  const index = loadIndex(ctx);
  const changed = syncGenerated(ctx, index);
  try { writeIndex(ctx, index); } catch (e) { io.err(`intent index: ${e.message}`); return 1; }
  io.out(`Indexed ${index.records.length} records, ${index.modules.length} modules${changed.length ? `; updated ${changed.join(', ')}` : ''}.`);
  for (const p of index.problems) io.out(`  ! ${p.kind}: ${p.message} (${p.path})`);
  return 0;
}
