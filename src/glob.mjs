import { posix } from 'node:path';

// Path globs: ** crosses folders, * and ? stay inside one segment.
// A plain path matches itself and everything below it; a trailing / means the folder.

// "." and ".." segments are resolved, so "src/../../x" reads as "../x" (outside the repo).
export function normalizePath(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s.startsWith('/')) s = s.slice(1);
  if (/(^|\/)\.{1,2}(\/|$)/.test(s)) {
    const trail = s.endsWith('/') ? '/' : '';
    s = posix.normalize(s).replace(/\/$/, '');
    s = s === '.' ? '' : s + (trail && s ? trail : '');
  }
  return s;
}

// Only * ? and {a,b} are glob syntax (SPEC §5): [id] and {legacy} are literal folder names.
export function hasGlob(p) {
  return /[*?]/.test(p) || /\{[^{}]*,[^{}]*\}/.test(p);
}

const cache = new Map();

export function globToRegex(pattern) {
  let p = normalizePath(pattern);
  if (p.endsWith('/')) p += '**';
  if (cache.has(p)) return cache.get(p);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > i && p.slice(i + 1, end).includes(',')) {
        re += '(?:' + p.slice(i + 1, end).split(',').map(escape).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else re += escape(c);
  }
  const rx = new RegExp('^' + re + '$');
  cache.set(p, rx);
  return rx;
}

function escape(s) {
  return s.replace(/[\\^$+.()|[\]{}*?]/g, '\\$&');
}

// A pattern is normalized and compiled once: capture and check match every file against every glob.
const compiled = new Map();
function compile(pattern) {
  const key = String(pattern);
  let c = compiled.get(key);
  if (c) return c;
  const p = normalizePath(key);
  c = { p, plain: p && !hasGlob(p) ? p.replace(/\/$/, '') : null, rx: p && hasGlob(p) ? globToRegex(p) : null };
  if (compiled.size > 20000) compiled.clear();
  compiled.set(key, c);
  return c;
}

export function matchPath(pattern, file) {
  const { p, plain, rx } = compile(pattern);
  if (!p) return false;
  const f = normalizePath(file).replace(/\/$/, '');
  if (plain !== null) return f === plain || f.startsWith(plain + '/');
  if (rx.test(f)) return true;
  // "src/a/**" also names the folder "src/a" itself.
  if (p.endsWith('/**') && f === p.slice(0, -3)) return true;
  if (p.endsWith('/') && f === p.slice(0, -1)) return true;
  return false;
}

export function isUnder(file, dir) {
  const f = normalizePath(file);
  const d = normalizePath(dir).replace(/\/$/, '');
  return d === '' || f === d || f.startsWith(d + '/');
}

// The literal folder prefix of a glob: "src/a/**/*.ts" -> "src/a".
export function globBase(pattern) {
  const p = normalizePath(pattern);
  if (!hasGlob(p)) return p.replace(/\/$/, '');
  const segs = p.split('/');
  const out = [];
  for (const s of segs) { if (hasGlob(s)) break; out.push(s); }
  return out.join('/');
}
