// Opt-in and configuration. A repo opts in with .intent.json at its root.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
      return toPosix(relative(root, resolve(base, p)));
    },
  };
}
