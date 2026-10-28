// Session state kept in <vault>/.cache/ (never committed): the files touched since
// the last capture, and per-session hook state.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePath } from './glob.mjs';

const SESSION_FILE = 'session.json';

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

export function readSession(ctx) {
  const s = readJson(join(ctx.cacheDir, SESSION_FILE), null);
  return s && Array.isArray(s.files) ? s : { files: [] };
}

// paths: repo-relative. Keeps the first and last touch time per file.
export function touch(ctx, paths, now = new Date()) {
  ensureCache(ctx);
  const s = readSession(ctx);
  const at = now.toISOString();
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (!path || path.startsWith('..')) continue;
    const hit = s.files.find((f) => f.path === path);
    if (hit) hit.last = at;
    else s.files.push({ path, first: at, last: at });
  }
  s.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  writeFileSync(join(ctx.cacheDir, SESSION_FILE), JSON.stringify(s, null, 2) + '\n');
  return s;
}

export function clearSession(ctx) {
  if (!existsSync(join(ctx.cacheDir, SESSION_FILE))) return;
  writeFileSync(join(ctx.cacheDir, SESSION_FILE), JSON.stringify({ files: [] }, null, 2) + '\n');
}

function hookFile(ctx, sessionId) {
  const id = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return join(ctx.cacheDir, `hook-${id}.json`);
}

export function readHookState(ctx, sessionId) {
  return readJson(hookFile(ctx, sessionId), { shown: [], blocked: false });
}

export function writeHookState(ctx, sessionId, state) {
  ensureCache(ctx);
  writeFileSync(hookFile(ctx, sessionId), JSON.stringify(state, null, 2) + '\n');
}
