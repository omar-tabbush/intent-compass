// intent touch: mark files as changed in this session, for the next intent capture.

import { loadContext } from '../config.mjs';
import { repoPath } from '../capture.mjs';
import { touch } from '../session.mjs';
import { notOptedIn } from './_shared.mjs';

export async function run({ positional, flags }, io) {
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  if (!positional.length) { io.err('Usage: intent touch PATH...'); return 1; }
  const paths = positional.map((p) => repoPath(ctx, p, io.cwd)).filter(Boolean);
  if (paths.length) touch(ctx, paths, io.now);
  if (flags.verbose) io.out(paths.length ? `Touched ${paths.join(', ')}` : 'Nothing touched: the paths are outside the repo.');
  return 0;
}
