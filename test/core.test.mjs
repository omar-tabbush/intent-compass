import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter, stringifyFrontmatter, sections, unwiki } from '../src/fm.mjs';
import { matchPath, globBase, normalizePath } from '../src/glob.mjs';
import { normalizeStatus, parseRecord, extractRefs, classify } from '../src/vault.mjs';
import { buildIndex, loadIndex, governing } from '../src/index.mjs';
import { nextNumber, slugify, recordRelPath } from '../src/ids.mjs';
import { renderRecord } from '../src/record.mjs';
import { replaceRegion, region } from '../src/generated.mjs';
import { loadContext } from '../src/config.mjs';
import { parseArgs } from '../src/io.mjs';
import { makeRepo, cleanup, record, moduleNote } from './helpers.mjs';

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
    positional: ['why', 'a'], flags: { json: true, min: '50', governs: 'a,b' },
  });
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
