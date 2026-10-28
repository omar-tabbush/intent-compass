// intent init: opt this folder in. Writes .intent.json and the vault skeleton when they
// are missing; each flag adds one piece. Never overwrites an existing file.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DEFAULTS, containsRepo, loadContext, readConfig, toPosix } from '../config.mjs';
import { stringifyFrontmatter } from '../fm.mjs';
import { HUB_FILE, region } from '../generated.mjs';
import { normalizePath } from '../glob.mjs';
import { indexWritable } from '../index.mjs';
import { checkSource, importReport, importVault, ungovernedModules } from '../importer.mjs';
import { list } from '../io.mjs';
import { applyRules } from '../rules.mjs';
import { git, isGitRepo } from '../git.mjs';
import { ensureCache } from '../session.mjs';
import { refresh } from './_shared.mjs';

export const BIN = fileURLToPath(new URL('../../bin/intent.mjs', import.meta.url));
export const SKILL_DIR = fileURLToPath(new URL('../../skill/intent-compass', import.meta.url));

const CODE_DIRS = ['src', 'app', 'lib', 'packages', 'server', 'client', 'backend', 'frontend', 'codebase'];
const VAULT_DIRS = ['decisions', 'modules', 'daily'];
const SETTINGS = '.claude/settings.local.json';
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const HOOK_EVENTS = [['PreToolUse', MATCHER], ['PostToolUse', MATCHER], ['Stop', null]];
const SETTINGS_IGNORED = new Set([
  SETTINGS, `/${SETTINGS}`, '.claude', '/.claude', '.claude/', '/.claude/', '.claude/*', '/.claude/*',
  'settings.local.json', '**/settings.local.json', '*.local.json',
]);
const CHANGED = new Set(['created', 'updated', 'added', 'replaced']);

const PKG_DIR = dirname(dirname(BIN));

// The hooks call bin/intent.mjs by its absolute path, but the rules block and the skill tell agents to run `intent`.
export function intentOnPath(env) {
  const names = process.platform === 'win32' ? ['intent.cmd', 'intent.exe', 'intent'] : ['intent'];
  return String(env.PATH || '').split(delimiter).filter(Boolean).some((d) => names.some((n) => existsSync(join(d, n))));
}

// Double quotes as before for an ordinary path; a path with $, `, ", \ or ! is single-quoted
// on POSIX shells, so the shell never expands it.
export function hookCommand(bin = BIN, platform = process.platform) {
  if (platform === 'win32' || !/[$`"\\!]/.test(bin)) return `node "${bin}" hook`;
  return `node '${bin.replace(/'/g, `'\\''`)}' hook`;
}

// Settings written by an earlier version hold the double-quoted form; it is the same hook.
const isOurHook = (cmd, command) => cmd === command || cmd === `node "${BIN}" hook`;
const TIMEOUT = { PreToolUse: 10, PostToolUse: 10, Stop: 60 }; // Stop runs capture over the whole change set

// --- config -------------------------------------------------------------------

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function codeRootsOf(root, flag) {
  const given = list(flag).map((c) => normalizePath(c).replace(/\/$/, '')).filter(Boolean);
  if (given.length) return given;
  const found = CODE_DIRS.filter((d) => isDir(join(root, d)));
  return found.length ? found : ['src'];
}

// DEFAULTS without the ignore list, so the defaults keep applying as they change.
function newConfig(root, flags) {
  return {
    version: DEFAULTS.version,
    vault: flags.vault !== undefined ? String(flags.vault) : DEFAULTS.vault,
    codeRoots: codeRootsOf(root, flags.code),
    areaDepth: DEFAULTS.areaDepth,
    reviewMonths: DEFAULTS.reviewMonths,
    proposedMaxDays: DEFAULTS.proposedMaxDays,
    rulesFiles: [...DEFAULTS.rulesFiles],
  };
}

// --- hooks --------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readSettings(root) {
  const file = join(root, SETTINGS);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  let data;
  try { data = text.trim() ? JSON.parse(text) : {}; } catch (e) { throw new Error(`${SETTINGS} is not valid JSON (${e.message}); left it unchanged`); }
  const bad = !isObject(data) || (data.hooks !== undefined && !isObject(data.hooks)) ||
    HOOK_EVENTS.some(([ev]) => data.hooks && data.hooks[ev] !== undefined && !Array.isArray(data.hooks[ev]));
  if (bad) throw new Error(`${SETTINGS} does not have the expected hooks shape; left it unchanged`);
  return data;
}

// Adds our hook to each event that lacks it. Existing keys and hook entries are kept as they are.
export function mergeHooks(root, command = hookCommand()) {
  const existing = readSettings(root);
  const settings = existing || {};
  const hooks = settings.hooks || {};
  const added = [];
  for (const [event, matcher] of HOOK_EVENTS) {
    const groups = hooks[event] || [];
    const has = groups.some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isObject(h) && isOurHook(h.command, command)));
    if (has) continue;
    const entry = { type: 'command', command, timeout: TIMEOUT[event] };
    hooks[event] = [...groups, matcher ? { matcher, hooks: [entry] } : { hooks: [entry] }];
    added.push(event);
  }
  if (!added.length) return { action: 'present', added };
  settings.hooks = hooks;
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, SETTINGS), JSON.stringify(settings, null, 2) + '\n');
  return { action: existing ? 'updated' : 'created', added };
}

// The settings file holds a machine-specific path, so keep it out of git: in .gitignore when the
// repo has one, else in git's info/exclude (found with rev-parse, so worktrees work).
// Returns { file, action } or { note } when nothing can ignore it.
function ignoreSettings(root) {
  let file = join(root, '.gitignore');
  let line = SETTINGS;
  if (!existsSync(file)) {
    const none = { note: `not ignored by git: add ${SETTINGS} to .gitignore` };
    if (!isGitRepo(root)) return none;
    try {
      file = resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
      const pre = git(root, ['rev-parse', '--show-prefix']).trim(); // exclude patterns are relative to the top level
      if (pre) line = `/${pre}${SETTINGS}`;
    } catch { return none; }
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (text !== null && text.split(/\r?\n/).some((l) => SETTINGS_IGNORED.has(l.trim()) || l.trim() === line)) return { file, action: 'present' };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, (text ?? '') + (text && !text.endsWith('\n') ? '\n' : '') + `${line}\n`);
  return { file, action: text === null ? 'created' : 'updated' };
}

// --- skill --------------------------------------------------------------------

function filesUnder(dir, rel = '') {
  let entries;
  try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

export function installSkill(root, { from = SKILL_DIR, force = false } = {}) {
  const files = filesUnder(from);
  if (!files.length) throw new Error(`skill files not found in ${from}`);
  const dest = join(root, '.claude', 'skills', 'intent-compass');
  return files.map((rel) => {
    const a = join(from, rel);
    const b = join(dest, rel);
    if (existsSync(b)) {
      if (readFileSync(a).equals(readFileSync(b))) return { path: b, action: 'present' };
      if (!force) return { path: b, action: 'kept', note: 'differs; --force replaces it' };
      copyFileSync(a, b);
      return { path: b, action: 'replaced' };
    }
    mkdirSync(dirname(b), { recursive: true });
    copyFileSync(a, b);
    return { path: b, action: 'created' };
  });
}

// --- vault ----------------------------------------------------------------------

function hubText() {
  return stringifyFrontmatter({ type: 'hub' }) + [
    '# Intent vault',
    '',
    '## What this is',
    '',
    'This vault keeps the *why* of the code: decision records and module notes that people and AI agents read before they change code. The markdown files are the truth; `index.json` and the generated part below are rebuilt from them by `intent index`.',
    '',
    '- `decisions/` holds cross-cutting records, `modules/<name>/` holds a module note and that module\'s records, `daily/` holds session notes.',
    '- Before changing a file, run `intent why <file>` and read the records it lists.',
    '- Records are append-only. Never edit the Decision or Why of an existing record and never delete one. To reverse a decision, write a new record that supersedes it.',
    '- Never invent a rationale. A Why that nobody stated stays TODO until a human gives it.',
    '',
    region('hub', ''),
    '',
  ].join('\n');
}

function ensureDir(dir, mark) {
  if (isDir(dir)) return mark(dir, 'present', true);
  mkdirSync(dir, { recursive: true });
  mark(dir, 'created', true);
}

function skeleton(ctx, mark) {
  ensureDir(ctx.vaultDir, mark);
  const hub = join(ctx.vaultDir, HUB_FILE);
  if (existsSync(hub)) mark(hub, 'present');
  else { writeFileSync(hub, hubText(), { flag: 'wx' }); mark(hub, 'created'); }
  for (const d of VAULT_DIRS) ensureDir(join(ctx.vaultDir, d), mark);
  const gi = join(ctx.vaultDir, '.gitignore');
  const before = existsSync(gi) ? readFileSync(gi, 'utf8') : null;
  ensureCache(ctx);
  mark(gi, before === null ? 'created' : before === readFileSync(gi, 'utf8') ? 'present' : 'updated');
}

// Only after the import, so a folder that received notes gets no placeholder.
function keepEmptyDirs(ctx, mark) {
  for (const d of VAULT_DIRS) {
    const dir = join(ctx.vaultDir, d);
    if (readdirSync(dir).length) continue;
    writeFileSync(join(dir, '.gitkeep'), '', { flag: 'wx' });
    mark(join(dir, '.gitkeep'), 'created');
  }
}

// --- command ------------------------------------------------------------------

// Everything that can fail is checked before anything is written.
function preflight(root, flags) {
  for (const f of ['vault', 'code', 'import']) {
    if (flags[f] === true || flags[f] === '') throw new Error(`--${f} needs a value`);
  }
  const hasConfig = existsSync(join(root, CONFIG_FILE));
  let config;
  if (hasConfig) {
    config = readConfig(root); // its error already names the file
  } else config = newConfig(root, flags);
  const vaultDir = isAbsolute(config.vault) ? config.vault : resolve(root, config.vault);
  // Notes at the repo root would be read as code (and code folders as vault folders).
  if (resolve(vaultDir) === root) throw new Error('the vault cannot be the repo root itself; use a folder such as intent-vault');
  if (containsRepo(vaultDir, root)) throw new Error('the vault cannot be the repo root or a folder that contains it; use a folder such as intent-vault');
  const indexFile = join(vaultDir, 'index.json');
  if (!indexWritable(indexFile)) throw new Error(`${indexFile} exists and is not an intent index; move it away`);
  const src = flags.import ? resolve(root, String(flags.import)) : null;
  if (src) checkSource(src, vaultDir);
  if (flags.skill && !filesUnder(SKILL_DIR).length) throw new Error(`skill files not found in ${SKILL_DIR}`);
  if (flags.hooks) readSettings(root);
  return { hasConfig, config, src };
}

function configWarnings(config, flags, root) {
  const out = [];
  if (flags.vault !== undefined && String(flags.vault) !== config.vault) {
    out.push(`kept the existing ${CONFIG_FILE}: --vault ${flags.vault} was not applied (vault is ${config.vault})`);
  }
  if (flags.code !== undefined && JSON.stringify(codeRootsOf(root, flags.code)) !== JSON.stringify(config.codeRoots)) {
    out.push(`kept the existing ${CONFIG_FILE}: --code ${flags.code} was not applied`);
  }
  return out;
}

export async function run({ flags }, io) {
  const root = resolve(io.cwd);
  let plan;
  try { plan = preflight(root, flags); } catch (e) { io.err(`intent init: ${e.message}`); return 1; }

  const steps = [];
  const show = (abs) => {
    const r = relative(root, abs);
    return r && !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r) ? toPosix(r) : toPosix(abs);
  };
  const mark = (abs, action, dir = false, note) => steps.push({ path: show(abs) + (dir ? '/' : ''), action, ...(note ? { note } : {}) });
  const warnings = plan.hasConfig ? configWarnings(plan.config, flags, root) : [];

  let ctx;
  let imported = null;
  try {
    const cfgFile = join(root, CONFIG_FILE);
    if (plan.hasConfig) mark(cfgFile, 'present');
    else { writeFileSync(cfgFile, JSON.stringify(plan.config, null, 2) + '\n', { flag: 'wx' }); mark(cfgFile, 'created'); }
    ctx = loadContext(root);
    skeleton(ctx, mark);
    if (plan.src) imported = importVault(ctx, plan.src, { now: io.now });
    keepEmptyDirs(ctx, mark);
    if (flags.hooks) {
      const h = mergeHooks(root);
      mark(join(root, SETTINGS), h.action, false, h.added.length ? `hooks: ${h.added.join(', ')}` : 'hooks already there');
      const gi = ignoreSettings(root);
      if (gi.file) mark(gi.file, gi.action, false, `ignores ${SETTINGS}`);
      else steps.at(-1).note += `; ${gi.note}`;
    }
    if (flags.skill) {
      for (const s of installSkill(root, { force: Boolean(flags.force) })) mark(s.path, s.action, false, s.note);
    }
    if (flags.rules) {
      for (const r of applyRules(ctx)) {
        const note = r.broken ? `broken markers (${r.broken}); fix them by hand` : r.reason || (r.action === 'skipped' ? 'no such file; left alone' : 'rules block');
        mark(resolve(root, r.file), r.action === 'unchanged' ? 'present' : r.action, false, note);
      }
    }
  } catch (e) {
    io.err(`intent init: ${e.message}`);
    return 1;
  }
  const index = refresh(ctx);
  const changed = steps.some((s) => CHANGED.has(s.action)) || Boolean(imported && (imported.imported.length || imported.modules.length));

  if (flags.json) {
    io.out(JSON.stringify({
      root,
      vault: show(ctx.vaultDir),
      changed,
      steps,
      import: imported && { ...imported, ungoverned: ungovernedModules(imported, index) },
      warnings,
      index: { records: index.records.length, modules: index.modules.length, problems: index.problems.length },
    }, null, 2));
    return 0;
  }
  io.out(`Intent Compass in ${root}`);
  for (const s of steps) io.out(`  ${s.action.padEnd(8)} ${s.path}${s.note ? `  (${s.note})` : ''}`);
  if (imported) for (const line of importReport(imported, { source: String(flags.import), vault: show(ctx.vaultDir), index })) io.out(line);
  for (const w of warnings) io.out(`  ! ${w}`);
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const problems = index.problems.length ? `, ${n(index.problems.length, 'problem')}` : '';
  io.out(`Index: ${n(index.records.length, 'record')}, ${n(index.modules.length, 'module')}${problems}.`);
  if (!changed) io.out('Nothing changed: everything was already in place.');
  io.out('Next steps:');
  if (!flags.rules) io.out('  intent rules   write the agent rules block into AGENTS.md / CLAUDE.md');
  io.out('  intent check   see the intent-debt score and what to record first');
  if (!intentOnPath(io.env)) io.out(`  npm install -g "${PKG_DIR}"   intent is not on PATH; agents are told to run it`);
  return 0;
}
