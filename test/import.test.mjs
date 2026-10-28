import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '../src/fm.mjs';
import { loadContext } from '../src/config.mjs';
import { loadIndex } from '../src/index.mjs';
import { importVault } from '../src/importer.mjs';
import { TODO_WHY } from '../src/vault.mjs';
import { makeRepo, run, read, exists, cleanup, tempDir, writeTree } from './helpers.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/obsidian-vault', import.meta.url));

function walkAll(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkAll(dir, child));
    else out.push(child);
  }
  return out.sort();
}

// Content hash and mtime of every file, dotfiles included.
function snapshot(dir, { mtime = true } = {}) {
  const map = {};
  for (const rel of walkAll(dir)) {
    const file = join(dir, rel);
    const hash = createHash('sha1').update(readFileSync(file)).digest('hex');
    map[rel] = mtime ? `${hash} ${statSync(file).mtimeMs}` : hash;
  }
  return map;
}

const decisionFiles = (dir) => walkAll(dir).filter((f) => /(^|\/)decisions\//i.test(f) && f.endsWith('.md') && !/(^|\/)_?templates?\//i.test(f));

// The body of a source note, the way the importer keeps it.
function sourceBody(text) {
  return splitFrontmatter(text).body;
}

async function importJson(root, args = []) {
  const res = await run(root, ['import', FIXTURE, '--json', ...args]);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('import: every decision file and module note is imported; the source is untouched', async () => {
  const before = snapshot(FIXTURE);
  const root = makeRepo();
  try {
    const out = await importJson(root);
    const want = decisionFiles(FIXTURE);
    assert.equal(want.length, 19);
    assert.equal(out.imported.length, want.length);
    assert.deepEqual(out.imported.map((i) => i.from).sort(), want);
    assert.deepEqual(out.modules.map((m) => [m.from, m.to]).sort(), [
      ['Modules/auth.md', 'modules/auth/auth.md'],
      ['Modules/dispatch/dispatch.md', 'modules/dispatch/dispatch.md'],
      ['Modules/invoicing/invoicing.md', 'modules/invoicing/invoicing.md'],
    ]);
    assert.ok(out.imported.some((i) => i.to === 'modules/invoicing/decisions/0003-per-branch-invoice-sequences.md'), 'Decisions/ becomes decisions/');
    assert.ok(exists(root, 'intent-vault/index.json'));
    assert.equal(JSON.parse(read(root, 'intent-vault/index.json')).records.length, want.length);
    assert.deepEqual(snapshot(FIXTURE), before, 'no source file changed, moved or appeared');
  } finally {
    cleanup(root);
  }
});

test('import: the rebuilt index reproduces effective statuses, supersede links and duplicate ids', async () => {
  const root = makeRepo();
  try {
    await importJson(root);
    const idx = loadIndex(loadContext(root));
    const eff = Object.fromEntries(idx.records.map((r) => [r.path, r.effectiveStatus]));
    assert.deepEqual(eff, {
      'decisions/0001-one-postgres-database.md': 'superseded',
      'decisions/0002-utc-everywhere.md': 'accepted',
      'decisions/0004-reporting-read-replica.md': 'accepted',
      'decisions/0019-feature-flags-live-in-config.md': 'accepted',
      'decisions/0019-sms-retry-budget.md': 'accepted',
      'decisions/0020-flag-service-for-tenant-rollouts.md': 'accepted',
      'decisions/0048-money-as-integer-cents.md': 'accepted',
      'modules/auth/decisions/0001-short-lived-session-tokens.md': 'accepted',
      'modules/auth/decisions/0002-passwordless-for-technicians.md': 'superseded',
      'modules/auth/decisions/0003-sso-for-enterprise-tenants.md': 'accepted',
      'modules/dispatch/decisions/0001-nearest-free-technician.md': 'superseded',
      'modules/dispatch/decisions/0002-no-double-booking.md': 'superseded',
      'modules/dispatch/decisions/0003-weighted-assignment.md': 'accepted',
      'modules/dispatch/decisions/0004-soft-holds-instead-of-locks.md': 'accepted',
      'modules/dispatch/decisions/0005-technician-self-swap.md': 'proposed',
      'modules/invoicing/decisions/0001-invoice-numbers-are-gapless.md': 'superseded',
      'modules/invoicing/decisions/0002-tax-rounding-per-line.md': 'proposed',
      'modules/invoicing/decisions/0003-per-branch-invoice-sequences.md': 'accepted',
      'modules/invoicing/decisions/0004-amounts-as-decimal-columns.md': 'superseded',
    });
    const by = (p) => idx.records.find((r) => r.path === p).supersededBy;
    assert.deepEqual(by('decisions/0001-one-postgres-database.md'), ['root/0004'], 'bare number');
    assert.deepEqual(by('modules/dispatch/decisions/0001-nearest-free-technician.md'), ['dispatch/0003'], 'sibling filename');
    assert.deepEqual(by('modules/dispatch/decisions/0002-no-double-booking.md'), ['dispatch/0004'], 'wikilink with alias');
    assert.deepEqual(by('modules/invoicing/decisions/0004-amounts-as-decimal-columns.md'), ['root/0048'], 'relative path');
    assert.deepEqual(by('modules/auth/decisions/0002-passwordless-for-technicians.md'), ['auth/0003'], 'markdown link');
    assert.deepEqual(by('modules/invoicing/decisions/0001-invoice-numbers-are-gapless.md'), ['invoicing/0003'], 'inline free-text status');
    const dups = idx.problems.filter((p) => p.kind === 'duplicate-id');
    assert.equal(dups.length, 1);
    assert.match(dups[0].message, /root\/0019/);
    assert.deepEqual(idx.problems.filter((p) => p.kind === 'unresolved-ref'), []);
    assert.equal(idx.records.find((r) => r.path === 'decisions/0002-utc-everywhere.md').module, 'dispatch', 'schema A module bullet');
  } finally {
    cleanup(root);
  }
});

test('import: frontmatter is normalized and the original body is kept verbatim', async () => {
  const root = makeRepo();
  try {
    const out = await importJson(root);
    for (const { from, to } of out.imported) {
      const target = read(root, `intent-vault/${to}`);
      const src = readFileSync(join(FIXTURE, from), 'utf8');
      assert.equal(splitFrontmatter(target).body, sourceBody(src), `${from}: body verbatim`);
      const fm = splitFrontmatter(target).data;
      assert.equal(fm.provenance, 'imported');
      assert.equal(fm.source, from);
      assert.equal(fm.imported_at, '2026-10-27');
      assert.ok(['proposed', 'accepted', 'superseded', 'deprecated'].includes(fm.status), `${from}: ${fm.status}`);
    }

    const b = splitFrontmatter(read(root, 'intent-vault/decisions/0001-one-postgres-database.md')).data;
    assert.equal(b.id, 'root/0001');
    assert.equal(b.title, 'One Postgres database for everything');
    assert.deepEqual(b.superseded_by, ['0004']);
    assert.equal(b['superseded-by'], undefined, 'alias folded into superseded_by');
    assert.equal(b['decided-by'], 'Mara Quill', 'unknown keys kept');
    assert.equal(b.module, 'root');
    assert.equal(b.module_raw, 'platform', 'a declared module that is not a module note is kept');
    assert.deepEqual(b.governs, []);
    assert.equal(b.review_date, null);
    assert.equal(b.status_raw, undefined, 'no status_raw when the status was already normal');

    const free = (p) => splitFrontmatter(read(root, `intent-vault/${p}`)).data;
    assert.equal(free('decisions/0019-feature-flags-live-in-config.md').status_raw, 'accepted (partially superseded by 0020)');
    assert.equal(free('decisions/0019-feature-flags-live-in-config.md').status, 'accepted');
    assert.equal(free('decisions/0019-sms-retry-budget.md').status_raw, 'decided');
    assert.equal(free('modules/dispatch/decisions/0004-soft-holds-instead-of-locks.md').status_raw, 'Design approved');
    assert.equal(free('modules/dispatch/decisions/0005-technician-self-swap.md').status, 'proposed');
    assert.equal(free('modules/invoicing/decisions/0002-tax-rounding-per-line.md').status_raw, 'DRAFT');
    assert.equal(free('decisions/0020-flag-service-for-tenant-rollouts.md').status_raw, undefined, 'case only');
    assert.deepEqual(free('decisions/0020-flag-service-for-tenant-rollouts.md').amends, ['0019']);
    assert.equal(free('decisions/0048-money-as-integer-cents.md').module, 'invoicing');
    assert.equal(free('decisions/0048-money-as-integer-cents.md').review_date, '2026-08-01');
    assert.deepEqual(free('decisions/0048-money-as-integer-cents.md').tags, ['money', 'invoicing']);
    assert.deepEqual(free('decisions/0004-reporting-read-replica.md').supersedes, ['[[0001-one-postgres-database]]'], 'raw supersedes');

    const inline = free('modules/invoicing/decisions/0001-invoice-numbers-are-gapless.md');
    assert.equal(inline.status, 'superseded');
    assert.equal(inline.status_raw, 'superseded by [[Modules/invoicing/Decisions/0003-per-branch-invoice-sequences|0003]]');
    assert.deepEqual(inline.superseded_by, ['[[Modules/invoicing/Decisions/0003-per-branch-invoice-sequences|0003]]']);

    const mixed = read(root, 'intent-vault/modules/dispatch/decisions/0002-no-double-booking.md');
    assert.equal(splitFrontmatter(mixed).data.status, 'superseded', 'frontmatter wins over the body bullet');
    assert.match(mixed, /\n- Status: Accepted\n/, 'body bullet kept');

    // Schema A: no frontmatter in the source, so the whole file is the body.
    const a = read(root, 'intent-vault/modules/auth/decisions/0001-short-lived-session-tokens.md');
    const srcA = readFileSync(join(FIXTURE, 'Modules/auth/decisions/0001-short-lived-session-tokens.md'), 'utf8');
    assert.ok(a.endsWith('\n---\n' + srcA));
    assert.equal(splitFrontmatter(a).data.id, 'auth/0001');
    assert.equal(splitFrontmatter(a).data.date, '2025-05-01');
    assert.ok(a.includes('`[[session]]`'), 'code span that looks like a wikilink is untouched');
    assert.ok(read(root, 'intent-vault/decisions/0048-money-as-integer-cents.md').includes('[[float-money]]'));
  } finally {
    cleanup(root);
  }
});

test('import: never invents a rationale', async () => {
  const root = makeRepo();
  try {
    await importJson(root);
    const idx = loadIndex(loadContext(root));
    const missing = idx.records.filter((r) => r.missingWhy).map((r) => r.id).sort();
    assert.deepEqual(missing, ['dispatch/0005', 'invoicing/0002']);
    const draft = read(root, 'intent-vault/modules/invoicing/decisions/0002-tax-rounding-per-line.md');
    assert.ok(!/## Why/.test(draft), 'no Why section added');
    assert.ok(!draft.includes(TODO_WHY));
    assert.match(read(root, 'intent-vault/modules/dispatch/decisions/0005-technician-self-swap.md'), /## Why — the intent\n\nTODO\n$/);
  } finally {
    cleanup(root);
  }
});

test('import: module notes get type, governs and appended markers; flat notes move into a folder', async () => {
  const root = makeRepo();
  try {
    const res = await run(root, ['import', FIXTURE]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Modules with no governs: invoicing\n {2}Add governs: \[paths\] to these module notes so intent why can find them\./);

    const auth = read(root, 'intent-vault/modules/auth/auth.md');
    const fm = splitFrontmatter(auth).data;
    assert.equal(fm.type, 'module');
    assert.equal(fm.module, 'auth');
    assert.deepEqual(fm.governs, ['src/auth/**']);
    assert.equal(fm.source, 'Modules/auth.md');
    const srcBody = sourceBody(readFileSync(join(FIXTURE, 'Modules/auth.md'), 'utf8'));
    assert.ok(splitFrontmatter(auth).body.startsWith(srcBody), 'original body first, verbatim');
    assert.match(auth, /<!-- intent:generated:decisions:start -->\n## Decisions[\s\S]*auth\/0003[\s\S]*<!-- intent:generated:decisions:end -->\n$/);

    const dispatch = splitFrontmatter(read(root, 'intent-vault/modules/dispatch/dispatch.md')).data;
    assert.equal(dispatch.owner, 'Teo Brandt');
    assert.deepEqual(dispatch.tags, ['module']);
    const inv = splitFrontmatter(read(root, 'intent-vault/modules/invoicing/invoicing.md')).data;
    assert.deepEqual(inv.governs, []);
    assert.deepEqual(inv.aliases, ['billing']);
  } finally {
    cleanup(root);
  }
});

test('import: hub, daily notes, templates, obsidian config and loose plan files are skipped and counted', async () => {
  const root = makeRepo();
  try {
    const out = await importJson(root);
    const reasons = Object.fromEntries(out.skipped.map((s) => [s.from, s.reason]));
    assert.equal(reasons['Tidepool.md'], 'hub note');
    assert.equal(reasons['daily/2026-09-14.md'], 'daily note');
    assert.equal(reasons['daily/2026-10-01.md'], 'daily note');
    assert.equal(reasons['_templates/decision.md'], 'template');
    assert.equal(reasons['_templates/daily.md'], 'template');
    assert.equal(reasons['.obsidian/'], 'obsidian config');
    assert.equal(reasons['Modules/dispatch/rollout-plan.md'], 'not a record or module note');
    assert.equal(reasons['attachments/day-board-sketch.txt'], 'not markdown');
    assert.ok(!exists(root, 'intent-vault/daily'), 'daily notes are not copied');
    assert.ok(!exists(root, 'intent-vault/Tidepool.md'));
    assert.ok(!exists(root, 'intent-vault/modules/dispatch/rollout-plan.md'));
    assert.ok(out.warnings.some((w) => w.includes('duplicate id root/0019')));

    const human = await run(root, ['import', FIXTURE, '--dry-run']);
    assert.match(human.stdout, /Skipped: .*hub note 1.*/);
    assert.match(human.stdout, /daily note 2/);
    assert.match(human.stdout, /template 2/);
  } finally {
    cleanup(root);
  }
});

test('import: running twice changes nothing the second time', async () => {
  const root = makeRepo();
  try {
    await importJson(root);
    const vault = join(root, 'intent-vault');
    const first = snapshot(vault, { mtime: false });
    const firstTimes = snapshot(vault);
    const again = await importJson(root);
    assert.equal(again.imported.length, 0);
    assert.equal(again.modules.length, 0);
    assert.equal(again.skipped.filter((s) => s.reason === 'already imported').length, 22);
    assert.deepEqual(snapshot(vault, { mtime: false }), first);
    const secondTimes = snapshot(vault);
    for (const [rel, v] of Object.entries(firstTimes)) {
      if (rel !== 'index.json') assert.equal(secondTimes[rel], v, `${rel} was rewritten`);
    }
  } finally {
    cleanup(root);
  }
});

test('import: an existing file in the vault is never overwritten', async () => {
  const mine = '---\nid: root/0048\nstatus: accepted\n---\n# Our own note\n\n## Why — the intent\n\nWe wrote this by hand.\n';
  const mod = '# dispatch\n\nHand-written.\n';
  const root = makeRepo({
    'intent-vault/decisions/0048-money-as-integer-cents.md': mine,
    'intent-vault/modules/dispatch/dispatch.md': mod,
  });
  try {
    const out = await importJson(root);
    assert.equal(read(root, 'intent-vault/decisions/0048-money-as-integer-cents.md'), mine);
    assert.equal(read(root, 'intent-vault/modules/dispatch/dispatch.md'), mod);
    const skipped = out.skipped.filter((s) => s.reason === 'target exists').map((s) => s.from).sort();
    assert.deepEqual(skipped, ['Modules/dispatch/dispatch.md', 'decisions/0048-money-as-integer-cents.md']);
    assert.ok(out.warnings.some((w) => w.includes('decisions/0048-money-as-integer-cents.md already exists')));
    assert.equal(out.imported.length, 18);
  } finally {
    cleanup(root);
  }
});

test('import: an existing record with the same ID is reported', async () => {
  const root = makeRepo({ 'intent-vault/decisions/0001-hand-written.md': '---\nid: root/0001\nstatus: accepted\n---\n# Hand\n' });
  try {
    const out = await importJson(root);
    assert.ok(out.warnings.some((w) => w.startsWith('root/0001 from decisions/0001-one-postgres-database.md has the same ID as decisions/0001-hand-written.md')));
  } finally {
    cleanup(root);
  }
});

test('import: two sources mapping to one target import only the first', async () => {
  const src = tempDir();
  const root = makeRepo();
  try {
    writeTree(src, {
      'modules/pay.md': '---\ngoverns: [src/pay/**]\n---\n# pay flat\n',
      'modules/pay/pay.md': '# pay folder\n',
      'modules/pay/decisions/0001-a.md': '---\nstatus: accepted\n---\n# A\n',
    });
    const out = await (async () => {
      const res = await run(root, ['import', src, '--json']);
      assert.equal(res.code, 0, res.stderr);
      return JSON.parse(res.stdout);
    })();
    assert.equal(out.modules.length, 1);
    assert.equal(out.modules[0].from, 'modules/pay/pay.md', 'the folder note comes first in walk order');
    assert.ok(out.warnings.some((w) => w.startsWith('modules/pay.md maps to modules/pay/pay.md, which modules/pay/pay.md already uses')));
    assert.deepEqual(out.skipped.filter((s) => s.reason === 'target exists').map((s) => s.from), ['modules/pay.md']);
    assert.ok(read(root, 'intent-vault/modules/pay/pay.md').includes('# pay folder'));
  } finally {
    cleanup(src);
    cleanup(root);
  }
});

test('import: refuses when source and target vault overlap, and writes nothing', async () => {
  const src = tempDir();
  try {
    cpSync(FIXTURE, src, { recursive: true });
    const before = snapshot(src);

    const inside = makeRepo({}, { config: { vault: join(src, 'nested-vault') } });
    const r1 = await run(inside, ['import', src]);
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /target vault .* is inside the source/);
    assert.ok(!exists(src, 'nested-vault'));
    cleanup(inside);

    const same = makeRepo({}, { config: { vault: src } });
    const r2 = await run(same, ['import', src]);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /same folder/);
    cleanup(same);

    assert.deepEqual(snapshot(src), before, 'source unchanged after refusals');

    const root = makeRepo({ 'intent-vault/old/decisions/0001-a.md': '# a\n- Status: accepted\n' });
    const r3 = await run(root, ['import', join(root, 'intent-vault/old')]);
    assert.equal(r3.code, 1);
    assert.match(r3.stderr, /source .* is inside the target vault/);
    assert.ok(!exists(root, 'intent-vault/decisions'));

    const r4 = await run(root, ['import', join(root, 'nope')]);
    assert.equal(r4.code, 1);
    assert.match(r4.stderr, /source not found/);

    const r5 = await run(root, ['import']);
    assert.equal(r5.code, 1);
    cleanup(root);

    assert.throws(() => importVault(loadContext(makeRepoAt(src)), src, {}), /inside the source/);
  } finally {
    cleanup(src);
  }
});

// A repo whose root is the source folder itself: the default vault lands inside it.
function makeRepoAt(dir) {
  writeFileSync(join(dir, '.intent.json'), JSON.stringify({ version: 1 }));
  return dir;
}

test('import: --dry-run reports what would happen and writes nothing', async () => {
  const root = makeRepo({ 'src/a.ts': '' });
  try {
    const before = snapshot(root);
    const res = await run(root, ['import', FIXTURE, '--dry-run']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^Would import 19 records and 3 module notes/);
    assert.match(res.stdout, /Dry run: nothing was written\./);
    assert.deepEqual(snapshot(root), before);
    const json = await run(root, ['import', FIXTURE, '--dry-run', '--json']);
    const out = JSON.parse(json.stdout);
    assert.equal(out.dryRun, true);
    assert.equal(out.imported.length, 19);
    assert.deepEqual(out.ungoverned, ['invoicing']);
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('import: silent unless opted in', async () => {
  const dir = tempDir();
  try {
    const res = await run(dir, ['import', FIXTURE]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /intent init/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('import: tolerant of odd notes (empty frontmatter, CRLF, nested map, non-records in decisions/)', async () => {
  const src = tempDir();
  const root = makeRepo();
  try {
    mkdirSync(join(src, 'decisions'), { recursive: true });
    writeTree(src, {
      'decisions/0007-empty-fm.md': '---\n---\n# Empty frontmatter\n\n## Decision\n\nx\n',
      'decisions/0008-crlf.md': '---\r\nid: 8\r\nstatus: Approved\r\nlinks:\r\n  issue: TP-12\r\n  doc: none\r\n---\r\n# CRLF note\r\n\r\n## Decision\r\n\r\ny\r\n',
      'decisions/README.md': '# Decisions index\n\nSee [[0007-empty-fm]].\n',
      'decisions/template.md': '# {{title}}\n## Decision\n',
    });
    const res = await run(root, ['import', src, '--json']);
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.imported.map((i) => i.id), ['root/0007', 'root/0008']);
    const reasons = Object.fromEntries(out.skipped.map((s) => [s.from, s.reason]));
    assert.equal(reasons['decisions/README.md'], 'not a record');
    assert.equal(reasons['decisions/template.md'], 'template');
    const e = read(root, 'intent-vault/decisions/0007-empty-fm.md');
    assert.ok(e.endsWith('\n---\n# Empty frontmatter\n\n## Decision\n\nx\n'));
    const c = read(root, 'intent-vault/decisions/0008-crlf.md');
    assert.ok(c.endsWith('# CRLF note\r\n\r\n## Decision\r\n\r\ny\r\n'), 'CRLF body verbatim');
    assert.match(c, /\nlinks:\n {2}issue: TP-12\n {2}doc: none\n---\n/, 'nested map kept line for line');
    assert.equal(splitFrontmatter(c).data.status, 'accepted');
  } finally {
    cleanup(src);
    cleanup(root);
  }
});
