// Session state kept in <vault>/.cache/ (never committed): the files touched since
// the last capture, and per-session hook state.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePath } from './glob.mjs';

// Touches are appended, one {"path","at"} line per file, so parallel hooks never lose each
// other's writes (a small O_APPEND write is atomic). session.json is the older format, still read.
const SESSION_FILE = 'session.json';
const TOUCH_LOG = 'session.jsonl';
const CLAIMED = 'session.jsonl.capturing';

export function ensureCache(ctx) {
  mkdirSync(ctx.cacheDir, { recursive: true });
  const gi = join(ctx.vaultDir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '.cache/\n');
  else {
    const text = readFileSync(gi, 'utf8');
    // Append only: the user's lines stay byte for byte.
    if (!/^\.cache\/?$/m.test(text)) writeFileSync(gi, text + (text === '' || text.endsWith('\n') ? '' : '\n') + '.cache/\n');
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function lines(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; }
}

export function readSession(ctx) {
  const files = new Map();
  const add = (path, first, last) => {
    if (typeof path !== 'string' || !path) return;
    const hit = files.get(path);
    if (!hit) files.set(path, { path, first, last });
    else {
      if (first < hit.first) hit.first = first;
      if (last > hit.last) hit.last = last;
    }
  };
  const legacy = readJson(join(ctx.cacheDir, SESSION_FILE), null);
  if (legacy && Array.isArray(legacy.files)) for (const f of legacy.files) if (f) add(f.path, f.first, f.last);
  for (const name of [CLAIMED, TOUCH_LOG]) {
    for (const line of lines(join(ctx.cacheDir, name))) {
      let e;
      try { e = JSON.parse(line); } catch { continue; } // a torn line is skipped, never the whole list
      if (e && typeof e.at === 'string') add(e.path, e.at, e.at);
    }
  }
  return { files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

// paths: repo-relative. Keeps the first and last touch time per file.
export function touch(ctx, paths, now = new Date()) {
  ensureCache(ctx);
  const at = now.toISOString();
  const entries = paths.map(normalizePath).filter((p) => p && !p.startsWith('..'));
  if (entries.length) appendFileSync(join(ctx.cacheDir, TOUCH_LOG), entries.map((path) => JSON.stringify({ path, at }) + '\n').join(''));
  return readSession(ctx);
}

// Capture takes the touches it is about to handle: touches appended while it runs land in a
// fresh session.jsonl and survive clearSession().
export function claimSession(ctx) {
  const log = join(ctx.cacheDir, TOUCH_LOG);
  const claimed = join(ctx.cacheDir, CLAIMED);
  if (!existsSync(log)) return;
  let size = 0;
  try { size = statSync(claimed).size; } catch { /* none yet */ }
  if (size === 0) { renameSync(log, claimed); return; }
  // A capture that failed earlier left its claim: add to it.
  appendFileSync(claimed, readFileSync(log, 'utf8'));
  writeFileSync(log, '');
}

export function clearSession(ctx) {
  if (existsSync(join(ctx.cacheDir, CLAIMED))) writeFileSync(join(ctx.cacheDir, CLAIMED), '');
  if (existsSync(join(ctx.cacheDir, SESSION_FILE))) writeFileSync(join(ctx.cacheDir, SESSION_FILE), JSON.stringify({ files: [] }, null, 2) + '\n');
}

// One state file per session (or session and subagent). A long id is shortened with a hash, so two never share a file.
function hookFile(ctx, sessionId) {
  const raw = String(sessionId || 'default');
  let id = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (id.length > 80 || id !== raw) id = `${id.slice(0, 60)}-${createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
  return join(ctx.cacheDir, `hook-${id}.json`);
}

export function readHookState(ctx, sessionId) {
  return readJson(hookFile(ctx, sessionId), { shown: [], blocked: false });
}

export function writeHookState(ctx, sessionId, state) {
  ensureCache(ctx);
  writeFileSync(hookFile(ctx, sessionId), JSON.stringify(state, null, 2) + '\n');
}
