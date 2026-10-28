// intent new: write a new decision record with an allocated ID. The Why stays TODO unless given.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { loadContext, vaultPath } from '../config.mjs';
import { loadIndex } from '../index.mjs';
import { freeNumber, nextNumber, recordRelPath, moduleRelPath, slugify, validModuleName } from '../ids.mjs';
import { renderRecord, reviewDateFor, isoDate } from '../record.mjs';
import { stringifyFrontmatter } from '../fm.mjs';
import { normalizePath } from '../glob.mjs';
import { validDate } from '../vault.mjs';
import { region } from '../generated.mjs';
import { list } from '../io.mjs';
import { usageOf } from '../cli.mjs';
import { notOptedIn, refresh } from './_shared.mjs';

const USAGE = usageOf('new');
const STATUSES = ['proposed', 'accepted'];
const PROVENANCES = ['human', 'ai-suggested', 'inferred-from-code', 'imported'];
const VALUE_FLAGS = ['governs', 'supersedes', 'why', 'context', 'decision', 'alternatives', 'consequences', 'provenance', 'status', 'review', 'tags'];

class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// "billing/0003", "billing/3", "billing 0003", or a bare number within ns.
// The namespace part is matched in any case: "billing/0001" finds Billing/0001.
export function resolveId(index, raw, ns) {
  const s = String(raw).trim();
  const ids = new Map();
  for (const r of index.records) if (!ids.has(r.id.toLowerCase())) ids.set(r.id.toLowerCase(), r.id);
  if (index.records.some((r) => r.id === s)) return s;
  if (ids.has(s.toLowerCase())) return ids.get(s.toLowerCase());
  const m = s.match(/^(?:([\w.-]+)[/ ]+)?(\d+)$/);
  if (!m) return null;
  return ids.get(`${m[1] || ns}/${m[2].padStart(4, '0')}`.toLowerCase()) ?? null;
}

// Repo-relative, with "." and ".." resolved: "src/../../x" climbs out and is refused.
function governsList(ctx, flag, cwd) {
  return list(flag).map((g) => {
    const rel = isAbsolute(g) ? ctx.rel(g, cwd) : normalizePath(g);
    const n = rel ? posix.normalize(rel) : '';
    if (!n || n === '.' || n === '..' || n.startsWith('../') || n.startsWith('/') || isAbsolute(n)) throw new Fail(`--governs ${g} is not a path inside the repo`);
    return n;
  });
}

const hasText = (v) => typeof v === 'string' && v.trim() !== '';

function defaultProvenance(env) {
  return env.CLAUDECODE || env.INTENT_AGENT ? 'ai-suggested' : 'human';
}

function reviewDate(flags, date, months) {
  if (flags.review !== undefined) {
    if (!validDate(flags.review)) throw new Fail(`--review must be a date YYYY-MM-DD, got "${flags.review}"`);
    return flags.review;
  }
  return reviewDateFor(date, months);
}

function moduleNoteText(name, governs) {
  return `${stringifyFrontmatter({ type: 'module', module: name, governs })}# ${name}\n\n${region('decisions', '## Decisions')}\n`;
}

function build(ctx, { positional, flags, late = [] }, io) {
  // "--governs src/a src/b": the second path would end up in the title (and the file name) forever.
  if (late.length && positional.length - late.length >= 2) {
    throw new Fail(`unexpected argument "${late[0]}" after a flag; quote the title and give --governs a comma-separated list (a,b)`, 2);
  }
  const [moduleArg, ...titleParts] = positional;
  const title = titleParts.join(' ').replace(/\s+/g, ' ').trim();
  if (!moduleArg || !title) throw new Fail(USAGE, 2);
  for (const f of VALUE_FLAGS) if (flags[f] === true) throw new Fail(`--${f} needs a value`, 2);

  let ns = moduleArg === 'root' ? 'root' : moduleArg;
  if (ns !== 'root' && !validModuleName(ns)) {
    throw new Fail(`invalid module name "${moduleArg}": use letters, digits, ".", "_" or "-", not decisions, modules or daily (or "root" for a cross-cutting record)`);
  }
  const status = flags.status ?? 'proposed';
  if (!STATUSES.includes(status)) throw new Fail(`--status must be one of ${STATUSES.join(', ')}, got "${status}"`);
  const provenance = flags.provenance ?? defaultProvenance(io.env);
  if (!PROVENANCES.includes(provenance)) throw new Fail(`--provenance must be one of ${PROVENANCES.join(', ')}, got "${provenance}"`);

  const index = loadIndex(ctx);
  // "billing" when the vault has modules/Billing/: one module, one namespace, on any file system.
  const spelled = ns === 'root' ? null : index.modules.find((m) => m.name.toLowerCase() === ns.toLowerCase())
    || index.records.find((r) => r.ns.toLowerCase() === ns.toLowerCase());
  if (spelled) ns = spelled.name ?? spelled.ns;
  const supersedes = list(flags.supersedes).map((raw) => {
    const id = resolveId(index, raw, ns);
    if (!id) throw new Fail(`--supersedes ${raw} does not match any record`);
    return id;
  });
  const date = isoDate(io.now);
  const num = freeNumber(ctx.vaultDir, ns, nextNumber(index, ns));
  const meta = {
    id: `${ns}/${num}`,
    title,
    status,
    date,
    module: ns === 'root' ? undefined : ns,
    governs: governsList(ctx, flags.governs, io.cwd),
    provenance,
    review_date: reviewDate(flags, date, ctx.config.reviewMonths),
    supersedes: [...new Set(supersedes)],
    tags: list(flags.tags),
  };
  const body = {
    context: flags.context,
    decision: hasText(flags.decision) ? flags.decision : title,
    why: flags.why,
    alternatives: flags.alternatives,
    consequences: flags.consequences,
  };
  const known = ns !== 'root' && index.modules.some((m) => m.name === ns);
  return { meta, body, rel: recordRelPath(ns, num, slugify(title)), moduleRel: ns === 'root' || known ? null : moduleRelPath(ns) };
}

function writeNew(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { flag: 'wx' }); // never overwrite, even if another writer got there first
}

export async function run(args, io) {
  const ctx = loadContext(io.cwd);
  if (!ctx) return notOptedIn(io);
  let plan;
  try { plan = build(ctx, args, io); } catch (e) {
    if (!(e instanceof Fail)) throw e;
    io.err(e.message === USAGE ? USAGE : `intent: ${e.message}`);
    return e.code;
  }
  const { meta, body, rel, moduleRel } = plan;
  const file = join(ctx.vaultDir, rel);
  if (existsSync(file)) { io.err(`intent: ${vaultPath(ctx, rel)} already exists; not overwriting it`); return 1; }
  try { writeNew(file, renderRecord(meta, body)); } catch (e) {
    if (e.code !== 'EEXIST' && e.code !== 'EISDIR') throw e;
    io.err(`intent: ${vaultPath(ctx, rel)} already exists; not overwriting it`);
    return 1;
  }
  let createdModule = null;
  if (moduleRel && !existsSync(join(ctx.vaultDir, moduleRel))) {
    try {
      writeNew(join(ctx.vaultDir, moduleRel), moduleNoteText(meta.module, meta.governs));
      createdModule = vaultPath(ctx, moduleRel);
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  refresh(ctx);
  const path = vaultPath(ctx, rel);
  if (args.flags.json) { io.out(JSON.stringify({ id: meta.id, path })); return 0; }
  io.out(`Created ${meta.id} (${meta.status}): ${path}`);
  if (createdModule) io.out(`Created module note: ${createdModule}`);
  if (!hasText(body.why)) {
    io.out('Why: TODO. Ask the human why and write their words in the record; do not guess.');
    if (meta.status === 'accepted') io.err(`intent: warning: accepted without a recorded why: ${meta.id}`);
  }
  if (meta.status === 'proposed') io.out(`Confirm with: intent accept ${meta.id}`);
  return 0;
}
