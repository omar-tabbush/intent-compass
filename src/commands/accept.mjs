// intent accept: confirm proposed records. The one edit the tool makes to an existing
// record: the status line goes from proposed to accepted, and nothing else changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContext, vaultPath } from '../config.mjs';
import { loadIndex } from '../index.mjs';
import { splitFrontmatter } from '../fm.mjs';
import { BODY_META_RES, metaKey, normalizeStatus, parseRecord } from '../vault.mjs';
import { notOptedIn, refresh } from './_shared.mjs';

// "billing 0003" may arrive as one argument or two.
function joinIds(positional) {
  const out = [];
  for (let i = 0; i < positional.length; i++) {
    const a = String(positional[i]).trim();
    const next = positional[i + 1];
    if (/^[\w.-]*[A-Za-z_.-][\w.-]*$/.test(a) && next !== undefined && /^\d+$/.test(next)) { out.push(`${a} ${next}`); i++; }
    else out.push(a);
  }
  return [...new Set(out)];
}

function findRecords(index, raw) {
  const exact = index.records.filter((r) => r.id === raw);
  if (exact.length) return { id: raw, hits: exact };
  if (/^\d+$/.test(raw)) {
    const near = index.records.filter((r) => r.id.endsWith('/' + raw.padStart(4, '0'))).map((r) => r.id);
    const hint = near.length ? ` (matches: ${[...new Set(near)].join(', ')})` : '';
    return { id: raw, error: `give the full id NAMESPACE/NNNN, not a bare number "${raw}"${hint}` };
  }
  const m = raw.match(/^([\w.-]+)(?:\/|\s+)(\d+)$/);
  const id = m ? `${m[1]}/${m[2].padStart(4, '0')}` : raw;
  const hits = index.records.filter((r) => r.id === id);
  return hits.length ? { id, hits } : { id: raw, error: `no record with id ${raw}` };
}

function lines(text, from, to) {
  const out = [];
  let at = from;
  while (at < to) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 || nl >= to ? to : nl;
    const raw = text.slice(at, end);
    const cr = raw.endsWith('\r') ? 1 : 0;
    out.push({ start: at, end: end - cr, line: raw.slice(0, raw.length - cr) });
    at = end + 1;
  }
  return out;
}

// Returns { start, end, value, next } for the status value to rewrite, or { error }.
function locateStatus(text) {
  const { data, body, hasFrontmatter } = splitFrontmatter(text);
  const fmEnd = text.length - body.length;
  if (hasFrontmatter && Object.keys(data).some((k) => metaKey(k) === 'status')) {
    // Like the reader: an exact "status:" key wins over "Status:".
    const fm = lines(text, 0, fmEnd);
    const exact = fm.filter((l) => /^status[ \t]*:[ \t]+\S/.test(l.line));
    const hits = exact.length ? exact : fm.filter((l) => /^status[ \t]*:[ \t]+\S/i.test(l.line));
    if (hits.length !== 1) return { error: `expected one "status:" line in the frontmatter, found ${hits.length}` };
    const l = hits[0];
    const prefix = l.line.match(/^status[ \t]*:[ \t]+/i)[0];
    return { start: l.start + prefix.length, end: l.end, value: l.line.slice(prefix.length) };
  }
  for (const l of lines(text, fmEnd, text.length)) {
    if (/^##\s/.test(l.line)) break;
    const m = BODY_META_RES.map((re) => l.line.match(re)).find(Boolean);
    if (m && metaKey(m[1]) === 'status') {
      return { start: l.end - m[2].length, end: l.end, value: m[2] };
    }
  }
  return { error: 'no status line found' };
}

function acceptFile(ctx, index, record) {
  const file = join(ctx.vaultDir, record.path);
  const text = readFileSync(file, 'utf8');
  const loc = locateStatus(text);
  if (loc.error) return { error: `${record.id}: ${loc.error} in ${vaultPath(ctx, record.path)}` };
  if (normalizeStatus(loc.value) !== 'proposed') return { error: `${record.id} is ${record.status} in ${vaultPath(ctx, record.path)}, not proposed; only proposed records can be accepted` };
  const next = text.slice(0, loc.start) + 'accepted' + text.slice(loc.end);
  // Check the reader sees exactly the edit we meant before anything is written.
  const opts = { ns: record.ns, moduleNames: new Set(index.modules.map((m) => m.name)) };
  const before = parseRecord(record.path, text, opts);
  const after = parseRecord(record.path, next, opts);
  if (after.status !== 'accepted' || after.id !== before.id || after.title !== before.title) {
    return { error: `${record.id}: could not edit the status line safely in ${vaultPath(ctx, record.path)}` };
  }
  writeFileSync(file, next);
  return { ok: true };
}

export async function run({ positional, flags }, io) {
  if (!positional.length) { io.err('usage: intent accept ID... [--json]'); return 2; }
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  const index = loadIndex(ctx);
  const accepted = [];
  const errors = [];
  const warnings = [];
  const fail = (id, message) => { errors.push({ id, message }); io.err(`intent: ${message}`); };
  const warn = (id, message) => { warnings.push({ id, message }); io.err(`intent: warning: ${message}`); };

  for (const raw of joinIds(positional)) {
    const found = findRecords(index, raw);
    if (found.error) { fail(raw, found.error); continue; }
    if (found.hits.length > 1) {
      fail(found.id, `id ${found.id} is used by ${found.hits.length} records; refusing to guess: ${found.hits.map((r) => vaultPath(ctx, r.path)).join(', ')}`);
      continue;
    }
    const r = found.hits[0];
    if (r.status !== 'proposed') { fail(r.id, `${r.id} is ${r.status}, not proposed; only proposed records can be accepted`); continue; }
    const res = acceptFile(ctx, index, r);
    if (res.error) { fail(r.id, res.error); continue; }
    accepted.push({ id: r.id, path: vaultPath(ctx, r.path) });
    if (r.missingWhy) warn(r.id, `accepted without a recorded why: ${r.id} (${vaultPath(ctx, r.path)})`);
    if (r.effectiveStatus === 'superseded') warn(r.id, `${r.id} is already superseded by ${r.supersededBy.join(', ')}; it stays superseded`);
  }
  if (accepted.length) refresh(ctx);
  if (flags.json) io.out(JSON.stringify({ accepted, errors, warnings }, null, 2));
  else for (const a of accepted) io.out(`Accepted ${a.id}: ${a.path}`);
  return errors.length ? 1 : 0;
}
