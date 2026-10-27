// intent index: rebuild index.json and the generated regions from the files.

import { loadContext } from '../config.mjs';
import { loadIndex, writeIndex } from '../index.mjs';
import { syncGenerated } from '../generated.mjs';
import { notOptedIn } from './_shared.mjs';

export async function run(_args, io) {
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  const index = loadIndex(ctx);
  writeIndex(ctx, index);
  const changed = syncGenerated(ctx, index);
  io.out(`Indexed ${index.records.length} records, ${index.modules.length} modules${changed.length ? `; updated ${changed.join(', ')}` : ''}.`);
  for (const p of index.problems) io.out(`  ! ${p.kind}: ${p.message} (${p.path})`);
  return 0;
}
