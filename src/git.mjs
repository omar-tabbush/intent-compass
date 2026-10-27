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

// Unstaged, staged and untracked changes, or changes since REF when given.
export function changedFiles(root, since = null) {
  if (!isGitRepo(root)) return [];
  const pre = prefix(root);
  const set = new Set();
  const lines = (args) => { try { return git(root, args).split('\n').map((s) => s.trim()).filter(Boolean); } catch { return []; } };
  if (since) for (const p of lines(['diff', '--name-only', '--relative', `${since}`, '--', '.'])) set.add(pre + p);
  else {
    for (const p of lines(['diff', '--name-only', 'HEAD', '--relative', '--', '.'])) set.add(pre + p);
    for (const p of lines(['diff', '--name-only', '--cached', '--relative', '--', '.'])) set.add(pre + p);
  }
  for (const p of lines(['ls-files', '--others', '--exclude-standard', '--', '.'])) set.add(pre + p);
  return strip(pre, [...set]).sort();
}

// Latest commit date (YYYY-MM-DD, committer date) per repo-relative file.
export function lastChangeMap(root) {
  const map = new Map();
  if (!isGitRepo(root)) return map;
  const pre = prefix(root);
  let out;
  try { out = git(root, ['log', '--format=%x00%cI', '--name-only', '--no-renames', '--', '.']); } catch { return map; }
  let date = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\0')) { date = line.slice(1, 11); continue; }
    const p = line.trim();
    if (!p || !date) continue;
    if (pre && !p.startsWith(pre)) continue;
    const rel = pre ? p.slice(pre.length) : p;
    if (!map.has(rel)) map.set(rel, date); // log is newest first
  }
  return map;
}
