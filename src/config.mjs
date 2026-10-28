// Opt-in and configuration. A repo opts in with .intent.json at its root.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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

const strings = (v, fallback) => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return [...fallback];
};
const number = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback);

// Missing or wrong-typed keys take the defaults: a hand-edited config never crashes a command.
export function readConfig(root) {
  const file = join(root, CONFIG_FILE);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    const err = new Error(`cannot read ${file}: ${e.message}; fix the JSON`);
    err.exitCode = 1;
    throw err;
  }
  const c = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULTS,
    ...c,
    vault: typeof c.vault === 'string' && c.vault.trim() ? c.vault : DEFAULTS.vault,
    codeRoots: strings(c.codeRoots, DEFAULTS.codeRoots),
    ignore: strings(c.ignore, DEFAULTS.ignore),
    rulesFiles: strings(c.rulesFiles, DEFAULTS.rulesFiles),
    areaDepth: number(c.areaDepth, DEFAULTS.areaDepth),
    reviewMonths: number(c.reviewMonths, DEFAULTS.reviewMonths),
    proposedMaxDays: number(c.proposedMaxDays, DEFAULTS.proposedMaxDays),
  };
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

// True when dir is a folder above root: its notes would be read from the repo's own code.
export function containsRepo(dir, root) {
  const r = relative(realPathOf(dir), realPathOf(root));
  return r !== '' && !outside(toPosix(r));
}

// The context every command works from, or null when the folder has not opted in.
export function loadContext(cwd = process.cwd()) {
  const root = findRoot(cwd);
  if (!root) return null;
  const config = readConfig(root);
  const vaultDir = isAbsolute(config.vault) ? config.vault : resolve(root, config.vault);
  if (containsRepo(vaultDir, root)) {
    const e = new Error(`the vault "${config.vault}" in ${join(root, CONFIG_FILE)} contains the repo; point "vault" at a folder such as intent-vault`);
    e.exitCode = 1;
    throw e;
  }
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

// One stderr line when the configured vault folder is missing, or holds nothing of a vault yet:
// a typo in "vault" would otherwise read as "no recorded intent". null when all is well.
export function vaultWarning(ctx) {
  const shown = ctx.vaultInRepo ? ctx.vaultRel : ctx.vaultDir;
  if (!existsSync(ctx.vaultDir)) return `intent: vault folder ${shown} (from ${CONFIG_FILE}) does not exist; fix "vault" or run intent init`;
  let names = [];
  try { names = readdirSync(ctx.vaultDir).map((n) => n.toLowerCase()); } catch { /* unreadable: say nothing */ return null; }
  if (['intent-vault.md', 'decisions', 'modules'].some((n) => names.includes(n))) return null;
  return `intent: vault folder ${shown} (from ${CONFIG_FILE}) has no hub, decisions/ or modules/ yet; fix "vault" or run intent init`;
}
