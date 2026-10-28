// The agent rules block written into AGENTS.md / CLAUDE.md. Plain markdown so any
// agent (Claude Code, Codex, Cursor, Copilot) follows the same rules.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { toPosix } from './config.mjs';
import { isUnder } from './glob.mjs';

export const START_RE = /<!-- intent-compass:start(?: hash=([a-f0-9]+))? -->/;
export const END = '<!-- intent-compass:end -->';

// null when the block can be rewritten safely: no markers at all, or one start before one end.
// Anything else (a lost end, a stray end, two blocks) is left for a human, because a rewrite
// could cut the user's text or add another block on every run.
export function brokenMarkers(text) {
  const starts = [...text.matchAll(new RegExp(START_RE.source, 'g'))].map((m) => m.index);
  const ends = [];
  for (let i = text.indexOf(END); i !== -1; i = text.indexOf(END, i + 1)) ends.push(i);
  if (!starts.length && !ends.length) return null;
  if (starts.length === 1 && ends.length === 1 && ends[0] > starts[0]) return null;
  return `${starts.length} start and ${ends.length} end marker${ends.length === 1 ? '' : 's'}`;
}

// rulesFiles from .intent.json; a single string is taken as a one-file list.
export function rulesFilesOf(config) {
  const v = config.rulesFiles;
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((f) => typeof f === 'string' && f.trim()) : [];
}

// The block's start match and the end marker after it, or null.
function findBlock(text) {
  const m = text.match(START_RE);
  if (!m) return null;
  const end = text.indexOf(END, m.index);
  return end === -1 ? null : { m, a: m.index, end };
}

export function rulesBody(ctx) {
  const vault = ctx.vaultRel;
  return [
    '## Intent Compass: read the why before you change code',
    '',
    `This repo records its intent (decisions and the why behind them) in \`${vault}/\`. Every agent follows these rules:`,
    '',
    '1. **Before editing a file**, run `intent why <file>` and read every accepted record it lists. Do not break an accepted decision without asking the user first.',
    '2. **After editing files**, run `intent touch <files...>`. In Claude Code the hooks do this for you.',
    '3. **When the user makes a load-bearing choice**, record it right away: `intent new <module> "<the rule, present tense>" --governs <path>[,<path>...] --why "<the user\'s own words>" --provenance ai-suggested`. To reverse a decision, add `--supersedes <id>`. Never edit an accepted record.',
    '4. **At the end of a task**, run `intent capture`. In each proposed record, fill the *Why* only with what the user actually said in this session and set `provenance: ai-suggested`; otherwise leave the TODO and ask. Never set `status: accepted` yourself: the user confirms with `intent accept <id>`.',
    '5. **Never invent a rationale.** If you do not know why code is the way it is, say "I don\'t know why this is here; it may be load-bearing" and ask.',
    `6. Never delete or rename files in \`${vault}/\`. The only hand edit there is filling the TODOs of a proposed record: the TODO in the frontmatter \`title:\` line and in the \`# \` heading, the Decision and the Why. Reversals are new records.`,
  ].join('\n');
}

export function hashOf(body) {
  return createHash('sha1').update(body).digest('hex').slice(0, 10);
}

export function rulesBlock(ctx) {
  const body = rulesBody(ctx);
  return `<!-- intent-compass:start hash=${hashOf(body)} -->\n${body}\n${END}`;
}

// State of one file: 'ok' | 'outdated' | 'missing' (file without block) | 'no-file'.
export function blockState(ctx, text) {
  if (text === null) return 'no-file';
  const at = findBlock(text);
  if (!at) return 'missing';
  const inner = text.slice(at.a + at.m[0].length, at.end).replace(/\r\n/g, '\n').replace(/^\n|\n$/g, '');
  const want = rulesBody(ctx);
  return at.m[1] === hashOf(want) && inner === want ? 'ok' : 'outdated';
}

export const OUTSIDE = 'outside the repo or inside the vault';

// The absolute path of a rulesFiles entry, or null when it would be outside the repo or in the vault.
export function rulesPath(ctx, file) {
  const p = resolve(ctx.root, file);
  const r = relative(ctx.root, p);
  if (!r || r === '..' || r.startsWith('..' + sep) || isAbsolute(r)) return null;
  if (ctx.vaultInRepo && ctx.vaultRel !== '.' && isUnder(toPosix(r), ctx.vaultRel)) return null;
  return p;
}

// [{file, state}], plus broken: '<marker counts>' for a file whose markers cannot be trusted.
// An entry outside the repo (or in the vault) has state 'skipped' and is never read or written.
export function rulesStatus(ctx) {
  return rulesFilesOf(ctx.config).map((file) => {
    const p = rulesPath(ctx, file);
    if (!p) return { file, state: 'skipped', reason: OUTSIDE };
    const text = existsSync(p) ? readFileSync(p, 'utf8') : null;
    const broken = text === null ? null : brokenMarkers(text);
    return broken ? { file, state: blockState(ctx, text), broken } : { file, state: blockState(ctx, text) };
  });
}

// Write or refresh the block. Creates AGENTS.md when missing; other files only when they exist,
// unless create is true. Returns [{file, action}] with action 'created' | 'added' | 'updated' | 'unchanged' | 'skipped';
// a file refused for broken markers is 'skipped' with broken: '<marker counts>' and is not touched.
export function applyRules(ctx, { create = false } = {}) {
  const block = rulesBlock(ctx);
  return rulesFilesOf(ctx.config).map((file) => {
    const p = rulesPath(ctx, file);
    if (!p) return { file, action: 'skipped', reason: OUTSIDE };
    if (!existsSync(p)) {
      if (file === 'AGENTS.md' || create) {
        writeFileSync(p, `# Agent instructions\n\n${block}\n`);
        return { file, action: 'created' };
      }
      return { file, action: 'skipped' };
    }
    const text = readFileSync(p, 'utf8');
    const broken = brokenMarkers(text);
    if (broken) return { file, action: 'skipped', broken };
    // The block takes the file's own line endings.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const blk = block.replace(/\n/g, eol);
    const at = findBlock(text);
    if (at) {
      const next = text.slice(0, at.a) + blk + text.slice(at.end + END.length);
      if (next === text) return { file, action: 'unchanged' };
      writeFileSync(p, next);
      return { file, action: 'updated' };
    }
    // Append after the user's text as it is, without trimming it.
    const gap = text === '' || text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
    writeFileSync(p, `${text}${gap}${blk}${eol}`);
    return { file, action: 'added' };
  });
}
