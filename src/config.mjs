// Opt-in and configuration. A repo opts in with .intent.json at its root.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CONFIG_FILE = '.intent.json';

export const DEFAULTS = Object.freeze({
  version: 1,
  vault: 'intent-vault',
  codeRoots: ['src'],
  areaDepth: 1,
  ignore: [
    'node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**',
    '.next/**', 'vendor/**', 'target/**', '.cache/**',
  ],
  reviewMonths: 6,
  proposedMaxDays: 14,
  rulesFiles: ['AGENTS.md', 'CLAUDE.md'],
});

export function findRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function readConfig(root) {
  const raw = JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8'));
  return { ...DEFAULTS, ...raw };
}

export function toPosix(p) {
  return p.split(sep).join('/');
}

// realpath of a path that may not exist yet (Write creates files): resolve the nearest existing parent.
export function realPathOf(abs) {
  const rest = [];
  let dir = abs;
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) break;
    rest.unshift(basename(dir));
    dir = up;
  }
  return join(realpathSync(dir), ...rest);
}

// Where a vault file is, as a reader opens it: repo-relative, or absolute when the vault is outside the repo.
export function vaultPath(ctx, rel) {
  if (!ctx.vaultInRepo) return toPosix(join(ctx.vaultDir, rel));
  return ctx.vaultRel === '.' ? rel : `${ctx.vaultRel}/${rel}`;
}

const outside = (r) => r === '..' || r.startsWith('../') || isAbsolute(r);

// Repo-relative posix path. When the plain answer is outside the root, real paths are compared
// too, because the root or the path may go through a symlink (macOS /tmp -> /private/tmp).
function relToRoot(root, abs) {
  const r = toPosix(relative(root, abs));
  if (!outside(r)) return r;
  try {
    const real = toPosix(relative(realpathSync(root), realPathOf(abs)));
    return outside(real) ? r : real;
  } catch {
    return r;
  }
}

// The context every command works from, or null when the folder has not opted in.
export function loadContext(cwd = process.cwd()) {
  const root = findRoot(cwd);
  if (!root) return null;
  const config = readConfig(root);
  const vaultDir = isAbsolute(config.vault) ? config.vault : resolve(root, config.vault);
  const vaultRel = toPosix(relative(root, vaultDir)) || '.';
  return {
    root,
    config,
    vaultDir,
    vaultRel,
    vaultInRepo: !vaultRel.startsWith('..') && !isAbsolute(vaultRel),
    cacheDir: join(vaultDir, '.cache'),
    // Repo-relative posix path of an absolute or cwd-relative path.
    rel(p, base = cwd) {
      return relToRoot(root, resolve(base, p));
    },
  };
}
