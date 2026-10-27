// Path globs: ** crosses folders, * and ? stay inside one segment.
// A plain path matches itself and everything below it; a trailing / means the folder.

export function normalizePath(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s.startsWith('/')) s = s.slice(1);
  return s;
}

export function hasGlob(p) {
  return /[*?[\]{}]/.test(p);
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
      if (end > i) {
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

export function matchPath(pattern, file) {
  const p = normalizePath(pattern);
  const f = normalizePath(file).replace(/\/$/, '');
  if (!p) return false;
  if (!hasGlob(p)) {
    const base = p.replace(/\/$/, '');
    return f === base || f.startsWith(base + '/');
  }
  if (globToRegex(p).test(f)) return true;
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
