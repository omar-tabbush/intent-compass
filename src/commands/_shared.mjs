// Helpers shared by commands.

import { loadIndex, writeIndex } from '../index.mjs';
import { syncGenerated } from '../generated.mjs';

export function notOptedIn(io) {
  io.err('intent: no .intent.json here or in any parent folder. Run `intent init` to opt this repo in.');
  return 1;
}

// After writing records: rebuild the index and generated regions from the files.
export function refresh(ctx) {
  const index = loadIndex(ctx);
  writeIndex(ctx, index);
  syncGenerated(ctx, index);
  return index;
}
