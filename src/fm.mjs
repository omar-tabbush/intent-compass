// Frontmatter and section parsing. A small YAML subset: scalars, inline lists,
// block lists. Anything richer is kept as a raw string so nothing is lost.

// An empty block ("---\n---\n") is still frontmatter, so it never leaks into the body.
const FM_RE = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return { data: {}, body: text, hasFrontmatter: false };
  return { data: parseYaml(m[1] ?? ''), body: text.slice(m[0].length), hasFrontmatter: true };
}

export function parseYaml(src) {
  const data = {};
  let key = null;
  for (const line of src.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-\s+(.*)$/) || line.match(/^\s*-$/);
    if (item && key !== null && (data[key] === null || Array.isArray(data[key]))) {
      if (!Array.isArray(data[key])) data[key] = [];
      if (item[1] !== undefined && item[1].trim() !== '') data[key].push(scalar(item[1]));
      continue;
    }
    const kv = !/^\s/.test(line) && line.match(/^([^\s:#][^:]*?)\s*:(?:\s+(.*)|\s*)$/);
    if (kv) {
      key = kv[1].trim();
      data[key] = value(kv[2] ?? '');
      continue;
    }
    // Nested map or folded text: keep it raw under the current key.
    if (key !== null) {
      const prev = data[key];
      data[key] = (typeof prev === 'string' && prev ? prev + '\n' : '') + line.trim();
    }
  }
  return data;
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function value(raw) {
  const s = stripComment(raw.trim());
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('[') && s.endsWith(']') && !s.startsWith('[[')) return splitList(s.slice(1, -1));
  if (s.startsWith('[[') && s.endsWith(']]') && s.slice(2, -2).includes(']], [[')) {
    return splitList(s.slice(1, -1));
  }
  return scalar(s);
}

function scalar(raw) {
  const s = stripComment(String(raw).trim());
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function splitList(inner) {
  const out = [];
  let cur = '';
  let depth = 0;
  let q = null;
  for (const c of inner) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { push(); continue; }
    cur += c;
  }
  push();
  return out;
  function push() {
    const v = scalar(cur);
    if (v !== null && v !== '') out.push(v);
    cur = '';
  }
}

const PLAIN = /^[A-Za-z0-9_./@][A-Za-z0-9_ ./@()+-]*$/;

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return String(v);
  const s = String(v);
  if (PLAIN.test(s) && !/^(true|false|null|~)$/.test(s) && !s.endsWith(' ')) return s;
  return JSON.stringify(s);
}

// Serialize in the key order given. Empty lists become [] and null becomes an empty value.
export function stringifyFrontmatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      const items = v.map(fmt);
      const inline = `[${items.join(', ')}]`;
      if (inline.length <= 100) lines.push(`${k}: ${inline}`);
      else { lines.push(`${k}:`); for (const it of items) lines.push(`  - ${it}`); }
    } else {
      const f = fmt(v);
      lines.push(f === '' ? `${k}:` : `${k}: ${f}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

// "## Heading" sections of a markdown body. Fenced code is skipped when looking for headings.
export function sections(body) {
  const list = [];
  let title = null;
  let cur = null;
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const h1 = line.match(/^#\s+(.+?)\s*#*\s*$/);
      if (h1 && title === null && !cur) { title = h1[1]; continue; }
      const h2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
      if (h2) { cur = { heading: h2[1], text: '' }; list.push(cur); continue; }
    }
    if (cur) cur.text += line + '\n';
  }
  for (const s of list) s.text = s.text.trim();
  return {
    title,
    list,
    get(re) { const s = list.find((x) => re.test(x.heading)); return s ? s.text : null; },
  };
}

// [[path|alias]] -> path, [[path]] -> path, [text](path) -> path. Other text unchanged.
export function unwiki(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/\[[^\]]*\]\(([^)]+)\)/g, '$1')
    .trim();
}
