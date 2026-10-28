// Generated regions inside hand-kept notes. Only text between the markers is
// ever rewritten; a note without markers is left alone.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const start = (name) => `<!-- intent:generated:${name}:start -->`;
const end = (name) => `<!-- intent:generated:${name}:end -->`;

export function region(name, content) {
  return `${start(name)}\n${content.trim()}\n${end(name)}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Marker lines only: a marker quoted in prose is just text.
function markerLines(text, marker) {
  const re = new RegExp(`^[ \\t]*${escapeRe(marker)}[ \\t]*(?=\\r?$)`, 'gm');
  return [...text.matchAll(re)].map((m) => ({ at: m.index, end: m.index + m[0].length }));
}

// null when the note has exactly one start line before one end line, or no markers at all;
// otherwise the marker counts. A rewrite of anything else could cut the user's text.
export function brokenRegion(text, name) {
  const a = markerLines(text, start(name));
  const b = markerLines(text, end(name));
  if (!a.length && !b.length) return null;
  if (a.length === 1 && b.length === 1 && b[0].at >= a[0].end) return null;
  return `${a.length} start and ${b.length} end marker${b.length === 1 ? '' : 's'}`;
}

export function replaceRegion(text, name, content) {
  const a = markerLines(text, start(name));
  const b = markerLines(text, end(name));
  if (a.length !== 1 || b.length !== 1 || b[0].at < a[0].end) return null;
  return text.slice(0, a[0].at) + region(name, content) + text.slice(b[0].end);
}

// Text from a record or note shown inside a region: an HTML comment in it must not end the region.
const inert = (s) => String(s).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');

export function wikilink(record) {
  return `[[${record.path.replace(/\.md$/i, '')}|${record.id}]]`;
}

function line(r) {
  const st = r.effectiveStatus === r.status ? r.effectiveStatus : `${r.status} → ${r.effectiveStatus}`;
  const by = r.supersededBy.length ? `, superseded by ${r.supersededBy.join(', ')}` : '';
  return `- ${wikilink(r)} — ${inert(r.title)} *(${st}${by})*`;
}

export function moduleDecisions(index, name) {
  const rs = index.records.filter((r) => r.module === name);
  return ['## Decisions', '', ...(rs.length ? rs.map(line) : ['_None recorded yet._'])].join('\n');
}

export function hubContent(index) {
  const out = [];
  const count = (s) => index.records.filter((r) => r.effectiveStatus === s).length;
  out.push('## Status', '');
  out.push(`${index.records.length} record${index.records.length === 1 ? '' : 's'}: ${count('accepted')} accepted, ${count('proposed')} proposed, ${count('superseded')} superseded, ${count('deprecated')} deprecated, ${count('unknown')} unknown.`);
  out.push('', '## Modules', '');
  if (!index.modules.length) out.push('_None yet._');
  for (const m of index.modules) {
    const gov = m.governs.length ? ` — governs \`${m.governs.map(inert).join('`, `')}\`` : ' — governs nothing yet';
    out.push(`- [[${m.path.replace(/\.md$/i, '')}|${inert(m.name)}]] (${m.decisions.length})${gov}`);
  }
  const root = index.records.filter((r) => r.ns === 'root');
  out.push('', '## Cross-cutting decisions', '');
  out.push(...(root.length ? root.map(line) : ['_None yet._']));
  const proposed = index.records.filter((r) => r.effectiveStatus === 'proposed');
  out.push('', '## Waiting for a human', '');
  out.push(...(proposed.length ? proposed.map(line) : ['_Nothing proposed._']));
  return out.join('\n');
}

export const HUB_FILE = 'intent-vault.md';

// Rewrite the hub and every module note that carries markers. Returns changed vault-relative paths.
// A note with broken markers is left alone and reported in index.problems.
export function syncGenerated(ctx, index) {
  const changed = [];
  const update = (rel, name, content) => {
    const file = join(ctx.vaultDir, rel);
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    const next = replaceRegion(text, name, content);
    if (next === null) {
      const broken = brokenRegion(text, name);
      if (broken) index.problems.push({ kind: 'broken-markers', path: rel, message: `intent:generated:${name} has ${broken}; fix them by hand` });
    } else if (next !== text) { writeFileSync(file, next); changed.push(rel); }
  };
  update(HUB_FILE, 'hub', hubContent(index));
  for (const m of index.modules) update(m.path, 'decisions', moduleDecisions(index, m.name));
  return changed;
}
