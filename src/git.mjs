// Thin git helpers. Every call degrades to "no data" outside a git repo.

import { execFileSync } from 'node:child_process';

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

export function isGitRepo(root) {
  try { return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; }
}

// Repo-relative paths: git reports them from the top level, so map to our root.
function prefix(root) {
  try { return git(root, ['rev-parse', '--show-prefix']).trim(); } catch { return ''; }
}

function strip(pre, paths) {
  return paths
    .filter(Boolean)
    .filter((p) => !pre || p.startsWith(pre))
    .map((p) => (pre ? p.slice(pre.length) : p));
}

// Unstaged, staged and untracked changes, or changes since REF when given. -z gives each name
// as raw bytes (no C-quoting of non-ASCII, quotes or tabs); --no-renames lists both ends of a move.
export function changedFiles(root, since = null) {
  if (!isGitRepo(root)) return [];
  const pre = prefix(root);
  const set = new Set();
  const names = (args) => { try { return git(root, args).split('\0').filter(Boolean); } catch { return []; } };
  const diff = ['diff', '--name-only', '-z', '--no-renames', '--relative'];
  if (since) for (const p of names([...diff, `${since}`, '--', '.'])) set.add(pre + p);
  else {
    for (const p of names([...diff, 'HEAD', '--', '.'])) set.add(pre + p);
    for (const p of names([...diff, '--cached', '--', '.'])) set.add(pre + p);
  }
  for (const p of names(['ls-files', '-z', '--others', '--exclude-standard', '--', '.'])) set.add(pre + p);
  return strip(pre, [...set]).sort();
}

// Latest commit day per repo-relative file: the committer date as a UTC day, the same
// clock isoDate() uses for record dates, so a commit on the record's day is never drift.
export function lastChangeMap(root) {
  const map = new Map();
  if (!isGitRepo(root)) return map;
  const pre = prefix(root);
  let out;
  try { out = git(root, ['-c', 'core.quotePath=false', 'log', '-z', '--format=%x01%cI', '--name-only', '--no-renames', '--', '.']); } catch { return map; }
  let date = null;
  for (const token of out.split('\0')) {
    const p = token.replace(/^\n/, '');
    if (p.startsWith('\x01')) {
      const d = new Date(p.slice(1).trim());
      date = Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      continue;
    }
    if (!p || !date) continue;
    if (pre && !p.startsWith(pre)) continue;
    const rel = pre ? p.slice(pre.length) : p;
    if (!map.has(rel)) map.set(rel, date); // log is newest first
  }
  return map;
}
