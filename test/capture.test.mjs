import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capture } from '../src/capture.mjs';
import { loadContext } from '../src/config.mjs';
import { parseRecord, TODO_WHY } from '../src/vault.mjs';
import { readSession } from '../src/session.mjs';
import { makeRepo, run, read, exists, cleanup, record, moduleNote, commitAll, gitRun, tempDir, writeTree, NOW } from './helpers.mjs';

const DAILY = 'intent-vault/daily/2026-10-27.md';

// Every file under dir (repo-relative) with a content hash; .git is skipped.
function snapshot(root, dir = '') {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out[child] = createHash('sha1').update(readFileSync(join(root, child))).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const stripRegion = (text) => text.replace(/<!-- intent:generated:decisions:start -->[\s\S]*<!-- intent:generated:decisions:end -->/, '');

async function json(root, args = []) {
  const r = await run(root, ['capture', '--json', ...args]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function lib(root, opts = {}) {
  return capture(loadContext(root), { now: new Date(NOW), ...opts });
}

test('capture: not opted in prints one stderr line and exits 1', async () => {
  const dir = tempDir();
  try {
    const r = await run(dir, ['capture']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /no \.intent\.json/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('capture: nothing changed prints "Nothing to capture." and writes nothing', async () => {
  const root = makeRepo({ 'src/a/x.ts': 'x' }, { git: true });
  try {
    commitAll(root, 'init', '2026-10-01');
    const before = snapshot(root);
    const r = await run(root, ['capture']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'Nothing to capture.');
    assert.deepEqual(snapshot(root), before);
    const j = await json(root);
    assert.deepEqual(j.proposals, []);
    assert.deepEqual(j.changed, []);
  } finally {
    cleanup(root);
  }
});

test('capture: groups by module, code area, top folder and repo root; allocates ids in sequence', async () => {
  const root = makeRepo({
    'src/billing/refunds/r.ts': 'r',
    'src/payments/p.ts': 'p',
    'src/payments/q.ts': 'q',
    'src/index.ts': 'i',
    'scripts/deploy.sh': 'd',
    'Makefile': 'm',
    'intent-vault/modules/billing/billing.md': moduleNote('billing', ['src/billing/**']),
    'intent-vault/decisions/0007-old.md': record({ id: 'root/0007', title: 'Old deprecated rule', status: 'deprecated', governs: ['src/payments/**'] }),
  }, { git: true });
  try {
    const j = await json(root);
    const by = Object.fromEntries(j.proposals.map((p) => [p.area, p]));
    assert.deepEqual(Object.keys(by).sort(), ['.', 'billing', 'scripts', 'src', 'src/payments']);
    assert.equal(by.billing.id, 'billing/0001');
    assert.equal(by.billing.module, 'billing');
    assert.deepEqual(by.billing.governs, ['src/billing/**']);
    assert.equal(by.billing.path, 'intent-vault/modules/billing/decisions/0001-captured-billing.md');
    assert.deepEqual(by['src/payments'].governs, ['src/payments/**'], 'a deprecated record does not cover the area');
    assert.deepEqual(by['src/payments'].files, ['src/payments/p.ts', 'src/payments/q.ts']);
    assert.deepEqual(by.src.governs, ['src/index.ts'], 'a file above area level is governed by its exact path');
    assert.deepEqual(by.scripts.governs, ['scripts/**']);
    assert.deepEqual(by['.'].governs, ['Makefile']);
    const rootIds = j.proposals.filter((p) => p.module === 'root').map((p) => p.id);
    assert.deepEqual(rootIds, ['root/0008', 'root/0009', 'root/0010', 'root/0011'], 'sequential after the highest existing number');
    for (const p of j.proposals) assert.ok(exists(root, p.path), p.path);
    const idx = JSON.parse(read(root, 'intent-vault/index.json'));
    assert.ok(idx.records.some((r) => r.id === 'billing/0001'), 'index refreshed');
    assert.match(read(root, 'intent-vault/modules/billing/billing.md'), /billing\/0001/, 'generated region refreshed');
  } finally {
    cleanup(root);
  }
});

test('capture: proposals hold facts only; Why stays the TODO marker', async () => {
  const root = makeRepo({ 'src/payments/p.ts': 'p' }, { git: true });
  try {
    const j = await json(root);
    assert.equal(j.proposals.length, 1);
    const text = read(root, j.proposals[0].path);
    const r = parseRecord(j.proposals[0].vaultPath, text, { ns: 'root' });
    assert.equal(r.id, 'root/0001');
    assert.equal(r.status, 'proposed');
    assert.equal(r.provenance, 'inferred-from-code');
    assert.equal(r.reviewDate, '2027-04-27', 'review date from config.reviewMonths, as intent new sets it');
    assert.equal(r.date, '2026-10-27');
    assert.equal(r.missingWhy, true);
    assert.equal(r.title, 'TODO: name the decision behind the change in src/payments');
    assert.match(text, /^module: root$/m);
    assert.ok(text.includes(`## Why — the intent\n\n${TODO_WHY}\n`));
    assert.ok(text.includes('## Decision\n\nTODO — state the rule this change follows, in the present tense.\n'));
    assert.ok(text.includes('## Alternatives rejected\n\nTODO\n'));
    assert.ok(text.includes('## Consequences\n\nTODO\n'));
    assert.ok(text.includes('- `src/payments/p.ts`'));
    assert.match(text, /2026-10-27/);
  } finally {
    cleanup(root);
  }
});

test('capture: covered areas list active records to re-check; existing records and notes are never edited', async () => {
  const files = {
    'src/billing/a.ts': 'a',
    'src/auth/login.ts': 'l',
    'intent-vault/modules/billing/billing.md': moduleNote('billing', ['src/billing/**']).replace('# billing\n', '# billing\nRefunds are touchy. Ask Priya.\n'),
    'intent-vault/modules/billing/decisions/0001-refunds.md': record({ id: 'billing/0001', title: 'Refunds go back to the original method', governs: [] }),
    'intent-vault/decisions/0001-auth.md': record({ id: 'root/0001', title: 'Sessions last one hour', governs: ['src/auth/**'] }),
  };
  const root = makeRepo(files, { git: true });
  try {
    const before = snapshot(root, 'intent-vault');
    const note = stripRegion(read(root, 'intent-vault/modules/billing/billing.md'));
    const j = await json(root);
    assert.deepEqual(j.proposals, []);
    assert.deepEqual(j.governedTouched.map((t) => [t.id, t.files]), [['billing/0001', ['src/billing/a.ts']], ['root/0001', ['src/auth/login.ts']]]);
    assert.equal(j.governedTouched[0].path, 'intent-vault/modules/billing/decisions/0001-refunds.md');
    const after = snapshot(root, 'intent-vault');
    for (const rel of Object.keys(before)) {
      if (rel.endsWith('/billing.md')) continue;
      assert.equal(after[rel], before[rel], `${rel} unchanged`);
    }
    assert.equal(stripRegion(read(root, 'intent-vault/modules/billing/billing.md')), note, 'hand text of the module note unchanged');
    const daily = read(root, DAILY);
    assert.match(daily, /\[\[modules\/billing\/decisions\/0001-refunds\|billing\/0001\]\]/);
    assert.match(daily, /\[\[decisions\/0001-auth\|root\/0001\]\]/);
  } finally {
    cleanup(root);
  }
});

test('capture: does not re-propose an area that already has a proposed record', async () => {
  const root = makeRepo({ 'src/payments/p.ts': 'p', 'src/legacy/l.ts': 'l', 'intent-vault/decisions/0003-legacy.md': record({ id: 'root/0003', title: 'Legacy draft', status: 'proposed', governs: ['src/legacy/**'] }) }, { git: true });
  try {
    const first = await json(root);
    assert.deepEqual(first.proposals.map((p) => p.id), ['root/0004']);
    assert.deepEqual(first.skipped, [{ area: 'src/legacy', reason: 'already proposed: root/0003' }]);
    writeFileSync(join(root, 'src/payments/p2.ts'), 'p2');
    const before = snapshot(root, 'intent-vault/decisions');
    const second = await json(root);
    assert.deepEqual(second.proposals, []);
    assert.deepEqual(second.skipped.map((s) => s.reason), ['already proposed: root/0003', 'already proposed: root/0004']);
    assert.deepEqual(snapshot(root, 'intent-vault/decisions'), before);
    const human = await run(root, ['capture']);
    assert.match(human.stdout, /src\/payments: already proposed: root\/0004/);
    assert.doesNotMatch(human.stdout, /intent accept/);
  } finally {
    cleanup(root);
  }
});

test('capture: daily note is appended to, never rewritten', async () => {
  const original = '# 2026-10-27\n\nMorning: paired with Dana on the ledger export.';
  const root = makeRepo({ 'src/ledger/x.ts': 'x', [DAILY]: original }, { git: true });
  try {
    await run(root, ['capture']);
    const text = read(root, DAILY);
    assert.ok(text.startsWith(original + '\n'), 'original text kept byte for byte');
    assert.match(text.slice(original.length), /\n## Captured by intent\n\n- Proposed \[\[decisions\/0001-captured-src-ledger\|root\/0001\]\] for src\/ledger \(1 file\)\n$/);
    writeFileSync(join(root, 'src/tax.ts'), 't');
    const once = read(root, DAILY);
    await run(root, ['capture']);
    assert.ok(read(root, DAILY).startsWith(once), 'second capture appends after the first');
    assert.equal(read(root, DAILY).match(/## Captured by intent/g).length, 2);
  } finally {
    cleanup(root);
  }
});

test('capture: creates the daily note with a date heading when missing', async () => {
  const root = makeRepo({ 'src/ledger/x.ts': 'x' }, { git: true });
  try {
    await run(root, ['capture']);
    assert.match(read(root, DAILY), /^# 2026-10-27\n\n## Captured by intent\n/);
  } finally {
    cleanup(root);
  }
});

test('capture --dry-run writes nothing and keeps the session list', async () => {
  const root = makeRepo({ 'src/ledger/x.ts': 'x', 'src/tax/t.ts': 't' }, { git: true });
  try {
    await run(root, ['touch', 'src/tax/t.ts']);
    const before = snapshot(root);
    const r = await run(root, ['capture', '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Would propose 2 record\(s\)/);
    assert.match(r.stdout, /Dry run: nothing written\./);
    const j = await json(root, ['--dry-run']);
    assert.equal(j.dryRun, true);
    assert.deepEqual(j.proposals.map((p) => p.id), ['root/0001', 'root/0002']);
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('capture --since REF uses the diff since that ref; bad refs fail', async () => {
  const root = makeRepo({ 'src/orders/o.ts': 'v1' }, { git: true });
  try {
    commitAll(root, 'one', '2026-10-01');
    const base = gitRun(root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'src/orders/o.ts'), 'v2');
    commitAll(root, 'two', '2026-10-02');
    assert.equal((await run(root, ['capture'])).stdout, 'Nothing to capture.');
    const j = await json(root, ['--since', base]);
    assert.deepEqual(j.changed, ['src/orders/o.ts']);
    assert.deepEqual(j.proposals.map((p) => p.area), ['src/orders']);
    assert.match(read(root, j.proposals[0].path), new RegExp(`changes since ${base}`));
    const bad = await run(root, ['capture', '--since', 'no-such-ref']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /unknown git ref: no-such-ref/);
    const bare = await run(root, ['capture', '--since']);
    assert.equal(bare.code, 1);
  } finally {
    cleanup(root);
  }
});

test('capture: deletions count as changes; unknown missing paths are dropped', async () => {
  const root = makeRepo({ 'src/old/gone.ts': 'g', 'src/old/kept.ts': 'k' }, { git: true });
  try {
    commitAll(root, 'init', '2026-10-01');
    rmSync(join(root, 'src/old/gone.ts'));
    await run(root, ['touch', 'src/never/existed.ts']);
    const j = await json(root);
    assert.deepEqual(j.changed, ['src/old/gone.ts']);
    assert.deepEqual(j.deleted, ['src/old/gone.ts']);
    assert.match(read(root, j.proposals[0].path), /- `src\/old\/gone\.ts` \(deleted\)/);
  } finally {
    cleanup(root);
  }
});

test('capture: ignores the vault, rules files, .intent.json, .claude and ignore globs', async () => {
  const root = makeRepo({
    'AGENTS.md': 'rules', 'CLAUDE.md': 'rules', 'docs/CLAUDE.md': 'rules',
    '.claude/settings.local.json': '{}',
    'node_modules/pkg/index.js': 'x',
    'dist/out.js': 'x',
    'intent-vault/decisions/0001-x.md': record({ id: 'root/0001', title: 'X', governs: ['src/x/**'] }),
  }, { git: true });
  try {
    await run(root, ['touch', 'intent-vault/decisions/0001-x.md', 'dist/out.js']);
    const r = await run(root, ['capture']);
    assert.equal(r.stdout, 'Nothing to capture.');
  } finally {
    cleanup(root);
  }
});

test('capture: works without git from the session touch list, then clears it', async () => {
  const root = makeRepo({ 'src/cart/c.ts': 'c', 'src/cart/d.ts': 'd' });
  try {
    await run(root, ['touch', 'src/cart/c.ts', 'src/cart/d.ts']);
    const j = await json(root);
    assert.deepEqual(j.proposals.map((p) => [p.id, p.files]), [['root/0001', ['src/cart/c.ts', 'src/cart/d.ts']]]);
    assert.deepEqual(readSession(loadContext(root)).files, []);
    assert.equal((await run(root, ['capture'])).stdout, 'Nothing to capture.');
  } finally {
    cleanup(root);
  }
});

test('capture: module with only superseded/deprecated records still gets a proposal; proposed one is skipped', async () => {
  const root = makeRepo({
    'src/search/s.ts': 's',
    'src/feed/f.ts': 'f',
    'intent-vault/modules/search/search.md': moduleNote('search', ['src/search/**']),
    'intent-vault/modules/search/decisions/0002-old.md': record({ id: 'search/0002', title: 'Old ranking', status: 'deprecated' }),
    'intent-vault/modules/feed/feed.md': moduleNote('feed', ['src/feed/**']),
    'intent-vault/modules/feed/decisions/0001-draft.md': record({ id: 'feed/0001', title: 'Draft feed rule', status: 'proposed' }),
  });
  try {
    const j = lib(root, { extraFiles: ['src/search/s.ts', join(root, 'src/feed/f.ts')] });
    assert.deepEqual(j.proposals.map((p) => p.id), ['search/0003']);
    assert.deepEqual(j.skipped, [{ area: 'feed', reason: 'already proposed: feed/0001' }]);
  } finally {
    cleanup(root);
  }
});

test('capture: context lists at most 30 files', async () => {
  const files = {};
  for (let i = 0; i < 33; i++) files[`src/big/f${String(i).padStart(2, '0')}.ts`] = String(i);
  const root = makeRepo(files, { git: true });
  try {
    const j = await json(root);
    const text = read(root, j.proposals[0].path);
    assert.equal(j.proposals[0].files.length, 33);
    assert.equal((text.match(/^- `src\/big\//gm) || []).length, 30);
    assert.match(text, /^- \.\.\. and 3 more$/m);
  } finally {
    cleanup(root);
  }
});

test('capture: human output names paths and the accept instruction; json is one document', async () => {
  const root = makeRepo({ 'src/cart/c.ts': 'c', 'src/auth/a.ts': 'a', 'intent-vault/decisions/0001-auth.md': record({ id: 'root/0001', title: 'Auth rule', governs: ['src/auth/**'] }) }, { git: true });
  try {
    const dry = await run(root, ['capture', '--json', '--dry-run']);
    assert.doesNotThrow(() => JSON.parse(dry.stdout));
    const r = await run(root, ['capture']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /root\/0002  intent-vault\/decisions\/0002-captured-src-cart\.md/);
    assert.match(r.stdout, /re-check/);
    assert.match(r.stdout, /root\/0001 \(accepted\)  intent-vault\/decisions\/0001-auth\.md/);
    assert.match(r.stdout, /Fill each Why only from what the user said; then ask the user to run: intent accept <id>/);
  } finally {
    cleanup(root);
  }
});

test('capture: config areaDepth and several code roots', async () => {
  const root = makeRepo({ 'src/shop/cart/c.ts': 'c', 'src/shop/x.ts': 'x', 'lib/util/u.ts': 'u' }, { config: { codeRoots: ['src', 'lib'], areaDepth: 2 } });
  try {
    const j = lib(root, { extraFiles: ['src/shop/cart/c.ts', 'src/shop/x.ts', 'lib/util/u.ts'], dryRun: true });
    assert.deepEqual(j.proposals.map((p) => [p.area, p.governs]), [
      ['lib/util', ['lib/util/u.ts']],
      ['src/shop', ['src/shop/x.ts']],
      ['src/shop/cart', ['src/shop/cart/**']],
    ]);
  } finally {
    cleanup(root);
  }
});

test('touch: silent, cwd-relative, skips outside paths; --verbose reports', async () => {
  const root = makeRepo({ 'src/cart/c.ts': 'c' });
  try {
    const r = await run(join(root, 'src'), ['touch', 'cart/c.ts', '../../outside.ts']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.deepEqual(readSession(loadContext(root)).files.map((f) => [f.path, f.first]), [['src/cart/c.ts', '2026-10-27T12:00:00.000Z']]);
    const v = await run(root, ['touch', 'src/cart/c.ts', '--verbose']);
    assert.equal(v.stdout, 'Touched src/cart/c.ts');
    assert.equal((await run(root, ['touch'])).code, 1);
  } finally {
    cleanup(root);
  }
});

test('touch: not opted in exits 1 and writes nothing', async () => {
  const dir = tempDir();
  try {
    writeTree(dir, { 'a.ts': '' });
    const r = await run(dir, ['touch', 'a.ts']);
    assert.equal(r.code, 1);
    assert.deepEqual(readdirSync(dir), ['a.ts']);
  } finally {
    cleanup(dir);
  }
});

test('capture: vault outside the repo', async () => {
  const outside = tempDir();
  mkdirSync(join(outside, 'vault'));
  const root = makeRepo({ 'src/cart/c.ts': 'c' }, { config: { vault: join(outside, 'vault') } });
  try {
    const j = lib(root, { extraFiles: ['src/cart/c.ts'] });
    assert.equal(j.proposals.length, 1);
    assert.ok(statSync(j.proposals[0].path).isFile(), 'absolute path when the vault is outside the repo');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('capture: non-ASCII and quoted file names come through git as real paths, never as phantom deletions', async () => {
  const root = makeRepo({ 'src/café/a.js': 'a', 'src/q"x/b.js': 'b' }, { git: true });
  try {
    const j = await json(root, ['--dry-run']);
    assert.deepEqual(j.changed, ['src/café/a.js', 'src/q"x/b.js']);
    assert.deepEqual(j.deleted, []);
    assert.deepEqual(j.proposals.map((p) => p.governs), [['src/café/**'], ['src/q"x/**']]);
  } finally {
    cleanup(root);
  }
});

test('capture: a staged rename lists both the old and the new path', async () => {
  const root = makeRepo({
    'src/a/x.js': 'export const x = 1;\n',
    'intent-vault/decisions/0001-a.md': record({ id: '0001', title: 'A rule', governs: ['src/a/**'] }),
    'intent-vault/decisions/0002-b.md': record({ id: '0002', title: 'B rule', governs: ['src/b/**'] }),
  }, { git: true });
  try {
    commitAll(root, 'init', '2026-10-01');
    mkdirSync(join(root, 'src/b'));
    gitRun(root, ['mv', 'src/a/x.js', 'src/b/x.js']);
    gitRun(root, ['add', '-A']);
    const j = await json(root, ['--dry-run']);
    assert.deepEqual(j.changed, ['src/a/x.js', 'src/b/x.js']);
    assert.deepEqual(j.deleted, ['src/a/x.js']);
    assert.deepEqual(j.governedTouched.map((t) => t.id), ['root/0001', 'root/0002']);
    commitAll(root, 'move', '2026-10-02');
    const since = await json(root, ['--dry-run', '--since', 'HEAD~1']);
    assert.deepEqual(since.changed, ['src/a/x.js', 'src/b/x.js']);
  } finally {
    cleanup(root);
  }
});

test('capture --help and misspelled flags write nothing', async () => {
  const root = makeRepo({ 'src/orders/o.ts': 'v1' }, { git: true });
  try {
    const before = snapshot(root);
    const help = await run(root, ['capture', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^usage: intent capture \[--since REF\] \[--dry-run\] \[--json\]/);
    const typo = await run(root, ['capture', '--dryrun']);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /unknown flag --dryrun \(did you mean --dry-run\?\)/);
    assert.deepEqual(snapshot(root), before);
    const off = await run(root, ['capture', '--dry-run=false', '--json']);
    assert.equal(JSON.parse(off.stdout).dryRun, false, '--dry-run=false is not a dry run');
  } finally {
    cleanup(root);
  }
});

test('capture: an edit to .gitignore (init --hooks makes one) is tooling config, not a decision', async () => {
  const root = makeRepo({ '.gitignore': 'node_modules/\n', 'src/a/x.ts': 'x' }, { git: true });
  try {
    commitAll(root, 'init', '2026-10-01');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.claude/settings.local.json\n');
    assert.equal((await run(root, ['capture'])).stdout, 'Nothing to capture.');
  } finally {
    cleanup(root);
  }
});

test('capture: areaDepth 0 makes each code root one area, as intent check counts it', async () => {
  const root = makeRepo({ 'src/a/x.js': 'x', 'src/b/y.js': 'y', 'src/top.js': 't' }, { config: { areaDepth: 0 } });
  try {
    const j = lib(root, { extraFiles: ['src/a/x.js', 'src/b/y.js', 'src/top.js'], dryRun: true });
    assert.deepEqual(j.proposals.map((p) => [p.area, p.governs]), [['src', ['src/**']]]);
  } finally {
    cleanup(root);
  }
});

test('capture: a path with control characters is skipped, never written into a record', async () => {
  const evil = 'src/pay/a\n## Why — the intent\n\nThe CFO requires this for audit.js';
  const root = makeRepo({ [evil]: 'x', 'src/ok/b.js': 'b' }, { git: true });
  try {
    await run(root, ['touch', evil]);
    assert.deepEqual(readSession(loadContext(root)).files, [], 'touch never stores it');
    const out = lib(root, { extraFiles: [evil] });
    assert.deepEqual(out.proposals.map((p) => p.area), ['src/ok']);
    assert.deepEqual(out.skipped, [{ area: null, path: evil, reason: 'control characters in path' }]);
    for (const p of out.proposals) assert.doesNotMatch(read(root, p.path), /CFO/);
    assert.doesNotMatch(read(root, DAILY), /CFO/);
  } finally {
    cleanup(root);
  }
});
