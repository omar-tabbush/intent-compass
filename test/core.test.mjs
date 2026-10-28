import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter, stringifyFrontmatter, sections, unwiki } from '../src/fm.mjs';
import { matchPath, globBase, hasGlob, normalizePath } from '../src/glob.mjs';
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStatus, parseRecord, parseModule, extractRefs, classify } from '../src/vault.mjs';
import { buildIndex, loadIndex, governing, refresh } from '../src/index.mjs';
import { freeNumber, nextNumber, slugify, recordRelPath, validModuleName } from '../src/ids.mjs';
import { renderRecord } from '../src/record.mjs';
import { replaceRegion, region, hubContent } from '../src/generated.mjs';
import { loadContext } from '../src/config.mjs';
import { parseArgs } from '../src/io.mjs';
import { listDirs } from '../src/walk.mjs';
import { ensureCache } from '../src/session.mjs';
import { refresh as sharedRefresh } from '../src/commands/_shared.mjs';
import { makeRepo, cleanup, record, moduleNote, tempDir } from './helpers.mjs';

test('frontmatter: scalars, inline and block lists, comments, quotes', () => {
  const { data, body, hasFrontmatter } = splitFrontmatter(
    '---\nid: 0004\ntitle: "A: quoted"\nstatus: accepted # note\ntags: [a, "b, c", [[x]]]\ngoverns:\n  - src/a/**\n  - src/b.ts\nempty:\nflag: true\n---\n# T\nbody',
  );
  assert.equal(hasFrontmatter, true);
  assert.equal(data.id, '0004');
  assert.equal(data.title, 'A: quoted');
  assert.equal(data.status, 'accepted');
  assert.deepEqual(data.tags, ['a', 'b, c', '[[x]]']);
  assert.deepEqual(data.governs, ['src/a/**', 'src/b.ts']);
  assert.equal(data.empty, null);
  assert.equal(data.flag, true);
  assert.equal(body, '# T\nbody');
});

test('frontmatter: round trip keeps values', () => {
  const data = { id: 'billing/0003', title: 'Refunds: original method', governs: ['src/billing/**'], review_date: null, tags: [] };
  const back = splitFrontmatter(stringifyFrontmatter(data) + 'x').data;
  assert.deepEqual(back, { ...data, review_date: null, tags: [] });
});

test('frontmatter: no frontmatter returns body unchanged', () => {
  const r = splitFrontmatter('# Title\n- Status: accepted');
  assert.equal(r.hasFrontmatter, false);
  assert.deepEqual(r.data, {});
});

test('sections and unwiki', () => {
  const s = sections('# Title\n\n## Context\nctx\n```\n## not a heading\n```\n## Why — the intent\nbecause\n');
  assert.equal(s.title, 'Title');
  assert.deepEqual(s.list.map((x) => x.heading), ['Context', 'Why — the intent']);
  assert.match(s.get(/^context/i), /not a heading/);
  assert.equal(s.get(/^why/i), 'because');
  assert.equal(unwiki('[[modules/a/decisions/0001-x|0001]]'), 'modules/a/decisions/0001-x');
  assert.equal(unwiki('[link](../0002-y.md)'), '../0002-y.md');
});

test('globs', () => {
  assert.equal(matchPath('src/billing/**', 'src/billing/a/b.ts'), true);
  assert.equal(matchPath('src/billing/**', 'src/billing'), true);
  assert.equal(matchPath('src/billing/**', 'src/billingx/a.ts'), false);
  assert.equal(matchPath('src/billing', 'src/billing/a.ts'), true);
  assert.equal(matchPath('src/billing/', 'src/billing/a.ts'), true);
  assert.equal(matchPath('src/*.ts', 'src/a.ts'), true);
  assert.equal(matchPath('src/*.ts', 'src/x/a.ts'), false);
  assert.equal(matchPath('**/*.test.mjs', 'test/a.test.mjs'), true);
  assert.equal(matchPath('**/*.test.mjs', 'a.test.mjs'), true);
  assert.equal(matchPath('src/{a,b}/**', 'src/b/x'), true);
  assert.equal(matchPath('src/a.ts', 'src/a.tsx'), false);
  assert.equal(globBase('src/a/**/*.ts'), 'src/a');
  assert.equal(normalizePath('./src\\a//b'), 'src/a/b');
});

test('status normalisation covers free-text variants', () => {
  const cases = {
    accepted: 'accepted', Accepted: 'accepted', decided: 'accepted', Built: 'accepted', 'Design approved': 'accepted',
    'accepted (partially superseded by 0009)': 'accepted', superseded: 'superseded', 'superseded by [[x]]': 'superseded',
    proposed: 'proposed', DRAFT: 'proposed', pending: 'proposed', 'In progress': 'proposed', deprecated: 'deprecated',
    '': 'unknown', banana: 'unknown',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeStatus(raw), want, raw);
});

test('parseRecord: frontmatter schema with numeric id and module folder', () => {
  const r = parseRecord('modules/billing/decisions/0004-refunds.md', '---\nid: 4\nstatus: accepted\ndate: 2026-09-01\nsuperseded-by: 0007\n---\n# Refunds\n\n## Decision\nx\n\n## Why — the intent\nreal reason\n', { ns: 'billing' });
  assert.equal(r.id, 'billing/0004');
  assert.equal(r.module, 'billing');
  assert.equal(r.title, 'Refunds');
  assert.equal(r.missingWhy, false);
  assert.deepEqual(r.supersededByRaw, ['0007']);
  assert.equal(r.schema, 'frontmatter');
});

test('parseRecord: body-bullet schema (no frontmatter)', () => {
  const r = parseRecord('modules/auth/decisions/0002-tokens.md', '# Short-lived tokens\n\n- Date: 2026-07-01\n- Status: Accepted\n- Module: [[auth]]\n\n## Context\nWe had a reason.\n\n## Decision\nx\n', { ns: 'auth' });
  assert.equal(r.id, 'auth/0002');
  assert.equal(r.status, 'accepted');
  assert.equal(r.date, '2026-07-01');
  assert.equal(r.schema, 'body-bullets');
  assert.equal(r.missingWhy, false, 'context counts as rationale when there is no Why section');
});

test('parseRecord: TODO why is missing rationale', () => {
  const r = parseRecord('decisions/0001-x.md', '---\nstatus: proposed\n---\n# X\n## Why — the intent\nTODO — not recorded.\n');
  assert.equal(r.missingWhy, true);
  assert.equal(r.id, 'root/0001');
});

test('extractRefs keeps repo paths only', () => {
  const refs = extractRefs('See `src/a/b.ts:12`, `prisma/schema/`, `npm run x`, `https://x.y/z.md`, `a/b`, `../up.ts`.');
  assert.deepEqual(refs, ['prisma/schema/', 'src/a/b.ts']);
});

test('classify layout', () => {
  assert.deepEqual(classify('decisions/0001-a.md'), { kind: 'record', ns: 'root' });
  assert.deepEqual(classify('modules/auth/decisions/0001-a.md'), { kind: 'record', ns: 'auth' });
  assert.deepEqual(classify('modules/auth/auth.md'), { kind: 'module', name: 'auth' });
  assert.deepEqual(classify('modules/auth/plan.md'), { kind: 'other' });
  assert.deepEqual(classify('daily/2026-10-01.md'), { kind: 'daily', date: '2026-10-01' });
});

function vaultOf(records, modules = []) {
  return { records, modules, dailies: [], problems: [] };
}

test('index: supersede is derived, never written; proposed replacement is pending', () => {
  const a = parseRecord('modules/b/decisions/0001-a.md', record({ id: '0001', title: 'A' }), { ns: 'b' });
  const b = parseRecord('modules/b/decisions/0002-b.md', record({ id: '0002', title: 'B', supersedes: ['0001'] }), { ns: 'b' });
  const c = parseRecord('modules/b/decisions/0003-c.md', record({ id: '0003', title: 'C', status: 'proposed', supersedes: ['b/0002'] }), { ns: 'b' });
  const idx = buildIndex(vaultOf([a, b, c]));
  const get = (id) => idx.records.find((r) => r.id === id);
  assert.equal(get('b/0001').status, 'accepted');
  assert.equal(get('b/0001').effectiveStatus, 'superseded');
  assert.deepEqual(get('b/0001').supersededBy, ['b/0002']);
  assert.equal(get('b/0002').effectiveStatus, 'accepted');
  assert.deepEqual(get('b/0002').pendingReplacements, ['b/0003']);
});

test('index: resolves supersede reference formats and reports duplicates', () => {
  const mk = (path, id, extra = '') => parseRecord(path, `---\nid: ${id}\nstatus: accepted\n${extra}---\n# t\n`, { ns: path.startsWith('modules/') ? path.split('/')[1] : 'root' });
  const recs = [
    mk('decisions/0019-a.md', '0019'),
    mk('decisions/0019-b.md', '0019'),
    mk('decisions/0043-x.md', '0043'),
    mk('modules/m/decisions/0002-y.md', '0002', 'supersedes: [root 0043]\n'),
    mk('modules/m/decisions/0003-z.md', '0003', 'supersedes: ["[[modules/m/decisions/0002-y|0002]]"]\n'),
    mk('modules/m/decisions/0004-w.md', '0004', 'supersedes: [../../../decisions/0019-b.md]\n'),
    mk('modules/m/decisions/0005-v.md', '0005', 'supersedes: [nope]\n'),
  ];
  const idx = buildIndex(vaultOf(recs));
  const get = (p) => idx.records.find((r) => r.path === p);
  assert.deepEqual(get('modules/m/decisions/0002-y.md').supersedes, ['root/0043']);
  assert.deepEqual(get('modules/m/decisions/0003-z.md').supersedes, ['m/0002']);
  assert.deepEqual(get('modules/m/decisions/0004-w.md').supersedes, ['root/0019']);
  assert.ok(idx.problems.some((p) => p.kind === 'duplicate-id' && p.message.includes('root/0019')));
  assert.ok(idx.problems.some((p) => p.kind === 'unresolved-ref' && p.message.includes('nope')));
});

test('ids: next number per namespace, slug, path', () => {
  const recs = [parseRecord('modules/b/decisions/0009-a.md', '# a', { ns: 'b' }), parseRecord('decisions/0002-a.md', '# a')];
  const idx = buildIndex(vaultOf(recs));
  assert.equal(nextNumber(idx, 'b'), '0010');
  assert.equal(nextNumber(idx, 'root'), '0003');
  assert.equal(nextNumber(idx, 'new'), '0001');
  assert.equal(slugify('Refunds go back: to the ORIGINAL method!'), 'refunds-go-back-to-the-original-method');
  assert.equal(recordRelPath('root', '0003', 'x'), 'decisions/0003-x.md');
  assert.equal(recordRelPath('b', '0010', 'x'), 'modules/b/decisions/0010-x.md');
});

test('renderRecord never fills a missing why', () => {
  const md = renderRecord({ id: 'b/0001', title: 'T', date: '2026-10-27', module: 'b', governs: ['src/b/**'], provenance: 'inferred-from-code' }, { context: 'Files changed: src/b/x.ts' });
  const r = parseRecord('modules/b/decisions/0001-t.md', md, { ns: 'b' });
  assert.equal(r.status, 'proposed');
  assert.equal(r.missingWhy, true);
  assert.match(md, /## Why — the intent\n\nTODO — not recorded\. Ask the human why; do not guess\./);
});

test('generated regions: replace only between markers', () => {
  const text = `keep\n${region('x', 'old')}\nkeep2`;
  assert.equal(replaceRegion(text, 'x', 'new'), `keep\n${region('x', 'new')}\nkeep2`);
  assert.equal(replaceRegion('no markers', 'x', 'new'), null);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['why', 'a', '--json', '--min', '50', '--governs=a,b']), {
    positional: ['why', 'a'], flags: { json: true, min: '50', governs: 'a,b' }, late: [], errors: [],
  });
  const p = parseArgs(['b', 'T', '--governs', 'x', '--governs', 'y', 'z', '--why', '--no-verify is banned', '--dry-run=false', '--json=1']);
  assert.deepEqual(p.flags, { governs: 'x,y', why: '--no-verify is banned', 'dry-run': false, json: true });
  assert.deepEqual(p.late, ['z']);
  assert.deepEqual(parseArgs(['--why', '--json']).flags, { why: true, json: true }, 'a flag-like word is a flag, not a value');
  assert.deepEqual(parseArgs(['--status', 'a', '--status', 'b']).errors, ['--status given more than once']);
});

test('governing: direct glob, module, mentions, folder query; ordering', () => {
  const root = makeRepo({
    'src/billing/refunds/r.ts': '',
    'src/billing/invoice.ts': '',
    'src/auth/login.ts': '',
    'intent-vault/modules/billing/billing.md': moduleNote('billing', ['src/billing/**']),
    'intent-vault/modules/billing/decisions/0001-old.md': record({ id: '0001', title: 'Old refunds', governs: ['src/billing/refunds/**'] }),
    'intent-vault/modules/billing/decisions/0002-new.md': record({ id: '0002', title: 'New refunds', governs: ['src/billing/refunds/**'], supersedes: ['0001'] }),
    'intent-vault/decisions/0001-x.md': record({ id: '0001', title: 'Mentions login' }).replace('Some context.', 'See `src/auth/login.ts`.'),
  });
  try {
    const ctx = loadContext(root);
    const idx = loadIndex(ctx);
    const g = governing(idx, ctx, 'src/billing/refunds/r.ts');
    assert.equal(g.isDir, false);
    assert.deepEqual(g.items.map((i) => i.record.id), ['billing/0002', 'billing/0001']);
    assert.ok(g.items[0].reasons.includes('governs src/billing/refunds/**'));
    assert.ok(g.items[0].reasons.includes('in module billing'));
    assert.equal(g.modules[0].module.name, 'billing');

    const inv = governing(idx, ctx, 'src/billing/invoice.ts');
    assert.deepEqual(inv.items.map((i) => [i.record.id, i.reasons]), [['billing/0002', ['in module billing']], ['billing/0001', ['in module billing']]]);

    const login = governing(idx, ctx, './src/auth/login.ts');
    assert.deepEqual(login.items.map((i) => i.record.id), ['root/0001']);
    assert.deepEqual(login.items[0].reasons, ['mentions src/auth/login.ts']);

    const dir = governing(idx, ctx, 'src/billing');
    assert.equal(dir.isDir, true);
    assert.equal(dir.items.length, 2);
    const srcDir = governing(idx, ctx, 'src');
    assert.equal(srcDir.items.length, 3);
    assert.equal(governing(idx, ctx, 'src/other.ts').items.length, 0);
  } finally {
    cleanup(root);
  }
});

test('loadContext: null when not opted in, finds root from subfolder', () => {
  const root = makeRepo({ 'src/a/b.ts': '' });
  try {
    const ctx = loadContext(root + '/src/a');
    assert.equal(ctx.root, root);
    assert.equal(ctx.vaultRel, 'intent-vault');
    assert.equal(ctx.vaultInRepo, true);
    assert.equal(loadContext('/'), null);
  } finally {
    cleanup(root);
  }
});

// Regression tests for core bugs found while integrating the commands.

test('frontmatter: an empty block is still frontmatter, not body text', () => {
  const r = splitFrontmatter('---\n---\n# Title\n');
  assert.equal(r.hasFrontmatter, true);
  assert.deepEqual(r.data, {});
  assert.equal(r.body, '# Title\n');
  assert.equal(splitFrontmatter('﻿---\r\n---\r\nx').body, 'x');
  assert.equal(parseRecord('decisions/0001-a.md', '---\n---\n# A\n\n- Status: accepted\n').status, 'accepted');
});

test('parseRecord: inline "superseded by [[link|alias]]" keeps the wikilink and resolves across namespaces', () => {
  const old = parseRecord('modules/inv/decisions/0001-a.md', '---\nstatus: Superseded by [[modules/pay/decisions/0003-b|0003]]\n---\n# A\n', { ns: 'inv' });
  assert.deepEqual(old.supersededByRaw, ['[[modules/pay/decisions/0003-b|0003]]']);
  const paren = parseRecord('decisions/0002-c.md', '---\nstatus: superseded (superseded by 0009)\n---\n# C\n');
  assert.deepEqual(paren.supersededByRaw, ['0009']);
  const neu = parseRecord('modules/pay/decisions/0003-b.md', '---\nstatus: accepted\n---\n# B\n', { ns: 'pay' });
  const idx = buildIndex(vaultOf([old, neu]));
  assert.deepEqual(idx.records.find((r) => r.id === 'inv/0001').supersededBy, ['pay/0003']);
  assert.equal(idx.records.find((r) => r.id === 'inv/0001').effectiveStatus, 'superseded');
  assert.deepEqual(idx.problems, []);
});

test('parseRecord and parseModule: capitalised frontmatter keys read like lowercase ones; an exact key wins', () => {
  const r = parseRecord('decisions/0001-a.md', '---\nStatus: Accepted\nReview Date: 2027-01-01\nGoverns: [src/a/**]\n---\n# A\n');
  assert.equal(r.status, 'accepted');
  assert.equal(r.reviewDate, '2027-01-01');
  assert.deepEqual(r.governs, ['src/a/**']);
  assert.equal(parseRecord('decisions/0002-b.md', '---\nstatus: proposed\nStatus: Accepted\n---\n# B\n').status, 'proposed');
  assert.deepEqual(parseModule('modules/m/m.md', '---\nType: module\nGoverns: [src/m/**]\n---\n# m\n', 'm').governs, ['src/m/**']);
});

test('index: a duplicate-id problem lists every path as an array too', () => {
  const recs = ['decisions/0007-a.md', 'decisions/0007-b, with comma.md'].map((p) => parseRecord(p, '---\nstatus: accepted\n---\n# t\n'));
  const dup = buildIndex(vaultOf(recs)).problems.find((p) => p.kind === 'duplicate-id');
  assert.deepEqual(dup.paths, ['decisions/0007-a.md', 'decisions/0007-b, with comma.md']);
});

test('listDirs: the vault is never a code folder, even with codeRoots ["."]', () => {
  const root = makeRepo({ 'src/a.ts': '', 'intent-vault/decisions/0001-a.md': record({ id: '0001', title: 'A' }) }, { config: { codeRoots: ['.'] } });
  try {
    assert.deepEqual(listDirs(loadContext(root), ''), ['src']);
  } finally {
    cleanup(root);
  }
});

test('ctx.rel: a path through a symlink still maps into the repo', () => {
  const root = makeRepo({ 'src/a/b.ts': '' });
  const linkDir = tempDir();
  try {
    const link = join(linkDir, 'repo');
    symlinkSync(root, link, 'dir');
    const viaLink = loadContext(link);
    assert.equal(viaLink.rel(join(realpathSync(root), 'src/a/b.ts')), 'src/a/b.ts');
    assert.equal(viaLink.rel(join(realpathSync(root), 'src/new/c.ts')), 'src/new/c.ts', 'a file Write is about to create');
    const direct = loadContext(root);
    assert.equal(direct.rel(join(link, 'src/a/b.ts')), 'src/a/b.ts');
    assert.ok(direct.rel(join(linkDir, 'elsewhere.ts')).startsWith('..'), 'outside stays outside');
  } finally {
    cleanup(linkDir);
    cleanup(root);
  }
});

test('freeNumber: skips numbers already on disk that the index has not seen', () => {
  const root = makeRepo({ 'intent-vault/decisions/0001-a.md': '', 'intent-vault/decisions/0002-b.md': '', 'intent-vault/modules/m/decisions/0005-x.md': '' });
  try {
    const vault = join(root, 'intent-vault');
    assert.equal(freeNumber(vault, 'root', '0001'), '0003');
    assert.equal(freeNumber(vault, 'root', '0004'), '0004');
    assert.equal(freeNumber(vault, 'm', 5), '0006');
    assert.equal(freeNumber(vault, 'none', '0001'), '0001');
  } finally {
    cleanup(root);
  }
});

test('ensureCache: appends .cache/ to an existing .gitignore without trimming it', () => {
  const root = makeRepo({ 'intent-vault/.gitignore': 'notes/\n\n\n' });
  try {
    ensureCache(loadContext(root));
    assert.equal(readFileSync(join(root, 'intent-vault/.gitignore'), 'utf8'), 'notes/\n\n\n.cache/\n');
  } finally {
    cleanup(root);
  }
});

test('refresh lives in the core; commands share the same function', () => {
  assert.equal(sharedRefresh, refresh);
});

test('hub: one record is "1 record"', () => {
  const idx = buildIndex(vaultOf([parseRecord('decisions/0001-a.md', '---\nstatus: accepted\n---\n# A\n')]));
  assert.match(hubContent(idx), /^1 record: 1 accepted,/m);
});

const rec = (path, text) => parseRecord(path, text, { ns: path.startsWith('modules/') ? path.split('/')[1] : 'root' });
const acc = (extra = '') => `---\nstatus: accepted\n${extra}---\n# t\n`;

test('index: a supersedes ref with a path picks that namespace, never the referring one', () => {
  const idx = buildIndex(vaultOf([
    rec('decisions/0005-unrelated.md', acc()),
    rec('modules/billing/decisions/0005-invoice-pdf.md', acc()),
    rec('decisions/0009-a.md', acc('supersedes: ["[[modules/billing/decisions/0005-invoice-pdfs]]"]\n')),
    rec('decisions/0010-b.md', acc('supersedes: ["modules/billing/decisions/0005-invoice-pdf.md (pdf part)"]\n')),
    rec('decisions/0011-c.md', acc('supersedes: ["archive/0005-old-thing"]\n')),
  ]));
  const get = (id) => idx.records.find((r) => r.id === id);
  assert.equal(get('root/0005').effectiveStatus, 'accepted', 'the unrelated root record stays active');
  assert.deepEqual(get('billing/0005').supersededBy, ['root/0009', 'root/0010']);
  assert.deepEqual(get('root/0011').supersedes, []);
  assert.ok(idx.problems.some((p) => p.kind === 'unresolved-ref' && p.message.includes('archive/0005-old-thing')));
});

test('index: a qualified ref resolves the same way in every notation', () => {
  const idx = buildIndex(vaultOf([
    rec('modules/billing/decisions/0001-retry-forever.md', acc()),
    rec('modules/billing/decisions/0003-a.md', acc('supersedes: ["[[0001-retry-forever]] — the backoff part only"]\n')),
    rec('modules/billing/decisions/0004-b.md', acc('supersedes: ["0001 (the backoff part only)"]\n')),
  ]));
  assert.deepEqual(idx.records.find((r) => r.id === 'billing/0001').supersededBy, ['billing/0003', 'billing/0004']);
  assert.deepEqual(idx.problems, []);
});

test('index: a ref naming one file supersedes only that file, even when its id is duplicated', () => {
  const idx = buildIndex(vaultOf([
    rec('decisions/0007-log-retention.md', acc()),
    rec('decisions/0007-nightly-backups.md', acc()),
    rec('decisions/0008-new.md', acc('supersedes: ["[[decisions/0007-log-retention]]"]\n')),
  ]));
  const byPath = (p) => idx.records.find((r) => r.path === p);
  assert.equal(byPath('decisions/0007-log-retention.md').effectiveStatus, 'superseded');
  assert.equal(byPath('decisions/0007-nightly-backups.md').effectiveStatus, 'accepted');
  assert.deepEqual(byPath('decisions/0008-new.md').supersedes, ['root/0007']);
});

test('index: Modules/ and Decisions/ in refs are matched in any case', () => {
  const idx = buildIndex(vaultOf([
    rec('decisions/0002-retry-policy.md', acc()),
    rec('modules/billing/decisions/0002-retry-policy.md', acc()),
    rec('decisions/0003-x.md', acc('supersedes: ["[[Modules/billing/Decisions/0002-retry-policy]]"]\n')),
    rec('modules/billing/decisions/0003-y.md', acc('supersedes: ["Decisions/0002"]\n')),
  ]));
  const get = (id) => idx.records.find((r) => r.id === id);
  assert.deepEqual(get('billing/0002').supersededBy, ['root/0003']);
  assert.deepEqual(get('root/0002').supersededBy, ['billing/0003']);
});

test('parseRecord: a date-prefixed filename is not a record number', () => {
  const a = rec('decisions/2023-10-05-use-postgres.md', '---\nstatus: accepted\n---\n# Use Postgres\n');
  const b = rec('decisions/20231101-use-redis.md', '---\nstatus: accepted\n---\n# Use Redis\n');
  assert.equal(a.id, 'root/2023-10-05-use-postgres');
  assert.equal(a.num, null);
  assert.equal(a.date, '2023-10-05');
  assert.equal(b.id, 'root/20231101-use-redis');
  assert.equal(b.date, '2023-11-01');
  const idx = buildIndex(vaultOf([a, b, rec('decisions/2023-11-01-x.md', acc())]));
  assert.deepEqual(idx.problems, []);
  assert.equal(nextNumber(idx, 'root'), '0001');
  const root = makeRepo({ 'intent-vault/decisions/2023-10-05-use-postgres.md': '', 'intent-vault/decisions/0001-a.md': '' });
  try {
    assert.equal(freeNumber(join(root, 'intent-vault'), 'root', '0001'), '0002');
    assert.equal(freeNumber(join(root, 'intent-vault'), 'root', '0003'), '0003');
  } finally {
    cleanup(root);
  }
});

test('nextNumber: a declared id counts in its own namespace, whatever the file is called', () => {
  const idx = buildIndex(vaultOf([
    rec('modules/billing/decisions/0002-old.md', '---\nid: billing/0004\nstatus: accepted\n---\n# t\n'),
    rec('decisions/0001-x.md', '---\nid: billing/0009\nstatus: accepted\n---\n# t\n'),
  ]));
  assert.equal(nextNumber(idx, 'billing'), '0010');
  assert.equal(nextNumber(idx, 'root'), '0002');
});

test('parseRecord: a short filename number is padded like a numeric id', () => {
  const r = rec('decisions/001-use-postgres.md', acc());
  assert.equal(r.id, 'root/0001');
  const idx = buildIndex(vaultOf([r, rec('decisions/0002-b.md', acc('supersedes: [1]\n'))]));
  assert.deepEqual(idx.records.find((x) => x.id === 'root/0002').supersedes, ['root/0001']);
});

test('globs: square brackets and braces without a comma are literal folder names', () => {
  assert.equal(hasGlob('src/app/[id]'), false);
  assert.equal(hasGlob('src/app/[...slug]/page.tsx'), false);
  assert.equal(hasGlob('src/{legacy}'), false);
  assert.equal(hasGlob('src/{a,b}/**'), true);
  assert.equal(matchPath('src/app/[id]', 'src/app/[id]/page.tsx'), true);
  assert.equal(matchPath('src/app/[id]/', 'src/app/[id]/page.tsx'), true);
  assert.equal(matchPath('src/{legacy}/**', 'src/{legacy}/a.js'), true);
  assert.equal(matchPath('src/{legacy}/**', 'src/legacy/a.js'), false);
  assert.equal(globBase('src/app/[...slug]/**'), 'src/app/[...slug]');
});

test('status normalisation: negated and rejected statuses are never active', () => {
  const cases = {
    'Not accepted': 'deprecated', 'not approved': 'deprecated', 'no longer active': 'deprecated', 'never implemented': 'deprecated',
    unapproved: 'deprecated', 'Proposal rejected': 'deprecated', 'Draft (abandoned)': 'deprecated', 'Review: rejected': 'deprecated',
    'proposed — rejected by legal 2026-09': 'deprecated', 'Pending removal': 'proposed', 'Not started': 'unknown',
    'accepted (partially superseded by 0009)': 'accepted', 'Design approved': 'accepted',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeStatus(raw), want, raw);
});

test('generated regions: markers count only as whole lines; anything unclear is left alone', () => {
  const s = '<!-- intent:generated:decisions:start -->';
  const e = '<!-- intent:generated:decisions:end -->';
  const prose = `The tool writes its list after \`${s}\`, see below.\n\nIMPORTANT USER TEXT that must survive.\n\n`;
  const text = `${prose}${s}\nold\n${e}\ntail\n`;
  assert.equal(replaceRegion(text, 'decisions', 'new'), `${prose}${s}\nnew\n${e}\ntail\n`);
  assert.equal(replaceRegion(`${s}\na\n${s}\nb\n${e}\n`, 'decisions', 'x'), null, 'two starts');
  assert.equal(replaceRegion(`${e}\n${s}\n`, 'decisions', 'x'), null, 'end before start');
  assert.equal(replaceRegion(`${s}\r\nold\r\n${e}\r\n`, 'decisions', 'new'), `${s}\nnew\n${e}\r\n`, 'CRLF lines still count');
});

test('generated regions: a title holding a marker cannot move the region; refresh is stable', () => {
  const root = makeRepo({
    'intent-vault/modules/m/m.md': moduleNote('m', ['src/m/**']),
    'intent-vault/modules/m/decisions/0001-a.md': record({ id: 'm/0001', title: 'Weird <!-- intent:generated:decisions:end --> markers', status: 'proposed' }),
    'intent-vault/modules/q/q.md': '---\ntype: module\nmodule: q\n---\n# q\n<!-- intent:generated:decisions:start -->\n<!-- intent:generated:decisions:start -->\n<!-- intent:generated:decisions:end -->\n',
  });
  try {
    const ctx = loadContext(root);
    const sizes = [1, 2, 3].map(() => { refresh(ctx); return readFileSync(join(root, 'intent-vault/modules/m/m.md'), 'utf8'); });
    assert.equal(sizes[0], sizes[2]);
    assert.equal(sizes[0].split('<!-- intent:generated:decisions:end -->').length, 2, 'one real end marker');
    const index = refresh(ctx);
    assert.ok(index.problems.some((p) => p.kind === 'broken-markers' && p.path === 'modules/q/q.md'));
  } finally {
    cleanup(root);
  }
});

test('loadVault: a README or other non-record note in decisions/ is skipped and reported, not indexed', () => {
  const root = makeRepo({
    'src/a.ts': '',
    'intent-vault/decisions/README.md': '# Decisions\n\nOne file per decision. See [[0001-a]].\n',
    'intent-vault/decisions/index.md': '# Index\n\n## Decision\n\nnot really\n',
    'intent-vault/decisions/notes.md': '# Loose notes\n\nNothing here.\n',
    'intent-vault/decisions/0001-a.md': record({ id: '0001', title: 'A', governs: ['src/a.ts'] }),
    'intent-vault/decisions/use-postgres.md': '---\nid: root/0042\n---\n# Use Postgres\n',
  });
  try {
    const index = loadIndex(loadContext(root));
    assert.deepEqual(index.records.map((r) => r.id).sort(), ['root/0001', 'root/0042']);
    const skipped = index.problems.filter((p) => p.kind === 'parse').map((p) => p.path).sort();
    assert.deepEqual(skipped, ['decisions/README.md', 'decisions/index.md', 'decisions/notes.md']);
    assert.match(index.problems.find((p) => p.path === 'decisions/notes.md').message, /not a decision record/);
  } finally {
    cleanup(root);
  }
});

test('frontmatter: a value starting with @ is quoted, so it stays valid YAML', () => {
  const text = stringifyFrontmatter({ title: '@scope/pkg is pinned', governs: ['@x/y', 'src/a'], tags: ['@team'] });
  assert.match(text, /^title: "@scope\/pkg is pinned"$/m);
  assert.match(text, /^governs: \["@x\/y", src\/a\]$/m);
  assert.deepEqual(splitFrontmatter(text + 'x').data, { title: '@scope/pkg is pinned', governs: ['@x/y', 'src/a'], tags: ['@team'] });
});

test('parseRecord: a BOM before a record without frontmatter keeps its H1 title and first bullet', () => {
  const r = parseRecord('decisions/0001-pg.md', '﻿- Status: accepted\r\n\r\n# One Postgres\r\n\r\n## Decision\r\n\r\nx\r\n');
  assert.equal(r.status, 'accepted');
  const t = parseRecord('decisions/0002-pg.md', '﻿# One Postgres\r\n\r\n- Status: accepted\r\n');
  assert.equal(t.title, 'One Postgres');
  assert.equal(splitFrontmatter('﻿# T\n').body, '# T\n');
});

test('parseRecord: only real calendar dates count', () => {
  assert.equal(parseRecord('decisions/0007-raise-limit-to-50000000.md', acc()).date, null);
  assert.equal(parseRecord('decisions/0008-ticket-12345678.md', acc()).date, null);
  assert.equal(parseRecord('decisions/0009-x.md', acc('date: 2026-13-45\n')).date, null);
  assert.equal(parseRecord('decisions/0010-x.md', acc('date: 2026-02-28\n')).date, '2026-02-28');
  assert.equal(parseRecord('decisions/0011-from-20260301.md', acc()).date, '2026-03-01');
});

test('frontmatter: folded and literal block scalars read as text, without the indicator', () => {
  const d = splitFrontmatter('---\ntitle: >\n  Long folded\n  title\nnotes: |\n  line one\n  line two\nstatus: accepted\n---\n').data;
  assert.equal(d.title, 'Long folded title');
  assert.equal(d.notes, 'line one\nline two');
  assert.equal(d.status, 'accepted');
});

test('parseRecord: body bullets wrapped onto indented lines keep their whole value', () => {
  const a = parseRecord('modules/ship/decisions/0001-a.md', '# A\n\n- Status:\n  accepted\n\n## Decision\nx\n', { ns: 'ship' });
  const b = parseRecord('modules/ship/decisions/0002-b.md', '# B\n\n- Status: superseded by\n  [[0004-d]]\n\n## Decision\nx\n', { ns: 'ship' });
  const c = parseRecord('modules/ship/decisions/0003-c.md', '# C\n\n- Status: accepted\n- Supersedes:\n  [[0001-a]]\n\n## Decision\nx\n', { ns: 'ship' });
  const d = parseRecord('modules/ship/decisions/0004-d.md', '# D\n\n- Status: accepted\n\n## Decision\nx\n', { ns: 'ship' });
  assert.equal(a.statusRaw, 'accepted');
  assert.deepEqual(b.supersededByRaw, ['[[0004-d]]']);
  assert.deepEqual(c.supersedesRaw, ['[[0001-a]]']);
  const idx = buildIndex(vaultOf([a, b, c, d]));
  assert.equal(idx.records.find((r) => r.id === 'ship/0001').effectiveStatus, 'superseded');
  assert.deepEqual(idx.problems, []);
});

test('classify: a module named "decisions" keeps its own namespace; the name is refused for new modules', () => {
  assert.deepEqual(classify('modules/decisions/decisions/0001-a.md'), { kind: 'record', ns: 'decisions' });
  assert.deepEqual(classify('modules/decisions/decisions.md'), { kind: 'module', name: 'decisions' });
  assert.deepEqual(classify('modules/auth/plan/decisions/0001-a.md'), { kind: 'record', ns: 'root' });
  assert.equal(validModuleName('decisions'), false);
  assert.equal(validModuleName('Decisions'), false);
  assert.equal(validModuleName('billing'), true);
});

test('governing: a one-segment glob does not govern a folder it only names', () => {
  const root = makeRepo({
    'src/a/deep/d.js': '',
    'src/a/top.js': '',
    'intent-vault/decisions/0001-s.md': record({ id: '0001', title: 'S', governs: ['src/a/*'] }),
  });
  try {
    const ctx = loadContext(root);
    const index = loadIndex(ctx);
    assert.deepEqual(governing(index, ctx, 'src/a/deep').items, []);
    assert.deepEqual(governing(index, ctx, 'src/a/deep/d.js').items, []);
    assert.equal(governing(index, ctx, 'src/a').items.length, 1, 'the folder holding the matched files');
    assert.equal(governing(index, ctx, 'src/a/top.js').items.length, 1);
  } finally {
    cleanup(root);
  }
});

test('readConfig: wrong-typed values fall back to the defaults; bad JSON names the file', async () => {
  const { run } = await import('./helpers.mjs');
  const root = makeRepo({ 'src/a/x.ts': '' }, { config: { codeRoots: 'src', ignore: 'dist/**', vault: null, areaDepth: 'deep', reviewMonths: 'six', proposedMaxDays: null, rulesFiles: 'AGENTS.md' } });
  try {
    const c = loadContext(root).config;
    assert.deepEqual(c.codeRoots, ['src']);
    assert.deepEqual(c.ignore, ['dist/**']);
    assert.equal(c.vault, 'intent-vault');
    assert.equal(c.areaDepth, 1);
    assert.equal(c.reviewMonths, 6);
    assert.equal(c.proposedMaxDays, 14);
    assert.deepEqual(c.rulesFiles, ['AGENTS.md']);
    for (const argv of [['check'], ['capture', '--dry-run'], ['why', 'src/a/x.ts']]) assert.equal((await run(root, argv)).code, 0, argv.join(' '));
    writeFileSync(join(root, '.intent.json'), '{bad');
    assert.throws(() => loadContext(root), (e) => /^cannot read .*\.intent\.json: .*; fix the JSON$/.test(e.message) && e.exitCode === 1);
  } finally {
    cleanup(root);
  }
});
