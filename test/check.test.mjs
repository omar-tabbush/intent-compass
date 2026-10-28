import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, areaFolders } from '../src/check.mjs';
import { loadContext } from '../src/config.mjs';
import { loadIndex } from '../src/index.mjs';
import { lastChangeMap } from '../src/git.mjs';
import { applyRules } from '../src/rules.mjs';
import { TODO_WHY } from '../src/vault.mjs';
import { makeRepo, run, read, exists, cleanup, record, moduleNote, commitAll, tempDir, writeTree, NOW } from './helpers.mjs';

const V = 'intent-vault';

function analyzeRepo(root, { git = false } = {}) {
  const ctx = loadContext(root);
  return analyze(ctx, loadIndex(ctx), { now: new Date(NOW), lastChange: git ? lastChangeMap(root) : new Map(), git });
}

async function checkJson(root, extra = []) {
  const r = await run(root, ['check', '--json', ...extra]);
  return { ...r, report: JSON.parse(r.stdout) };
}

function penalty(report, kind) {
  return report.penalties.find((p) => p.kind === kind);
}

// Every file under root except .git, with its content.
function snapshot(root) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out[child] = readFileSync(join(root, child), 'utf8');
    }
  };
  walk('');
  return out;
}

// One of every penalty kind, with counts small enough to stay under the caps.
function fixture() {
  const root = makeRepo({
    'src/billing/refunds/r.ts': 'export const refund = 1;\n',
    'src/billing/invoice.ts': 'export const invoice = 1;\n',
    'src/auth/login.ts': 'export const login = 1;\n',
    'src/search/q.ts': 'export const q = 1;\n',
    'src/payments/p.ts': 'export const p = 1;\n',
    [`${V}/modules/billing/billing.md`]: moduleNote('billing', ['src/billing/**']),
    // drift (r.ts changes later) and overdue review
    [`${V}/modules/billing/decisions/0001-refunds.md`]: record({ id: '0001', title: 'Refunds go to the original card', module: 'billing', governs: ['src/billing/refunds/**'], review_date: '2026-10-01' }),
    // dead governs and no why
    [`${V}/modules/billing/decisions/0002-ledger.md`]: record({ id: '0002', title: 'Ledger is append-only', module: 'billing', governs: ['src/billing/ledger/**'], why: TODO_WHY }),
    [`${V}/decisions/0001-sessions.md`]: record({ id: '0001', title: 'Sessions expire after 30 minutes', governs: ['src/auth/**'] }),
    // unreachable; its mention of search code does not cover the search area
    [`${V}/decisions/0002-search.md`]: record({ id: '0002', title: 'Search is case-insensitive' }).replace('Some context.', 'See `src/search/q.ts`.'),
    // stale proposal; proposed records do not cover an area either
    [`${V}/decisions/0003-cache.md`]: record({ id: '0003', title: 'Cache search results', status: 'proposed', governs: ['src/search/**'] }),
    [`${V}/decisions/0004-rate-limit.md`]: record({ id: '0004', title: 'Rate limit logins', status: 'proposed', date: '2026-10-20', governs: ['src/auth/**'] }),
    // duplicate id, and an unresolved supersedes
    [`${V}/decisions/0005-opaque.md`]: record({ id: '0005', title: 'Tokens are opaque', governs: ['src/auth/**'] }),
    [`${V}/decisions/0005-rotate.md`]: record({ id: '0005', title: 'Tokens rotate daily', governs: ['src/auth/**'] }),
    [`${V}/decisions/0006-argon.md`]: record({ id: '0006', title: 'Passwords use argon2', governs: ['src/auth/**'], supersedes: ['nope'] }),
  }, { git: true });
  mkdirSync(join(root, 'src/empty'), { recursive: true });
  commitAll(root, 'initial', '2026-08-01');
  writeTree(root, { 'src/billing/refunds/r.ts': 'export const refund = 2;\n' });
  commitAll(root, 'change refunds', '2026-10-05');
  return root;
}

test('check: not opted in prints one stderr line and exits 1', async () => {
  const dir = tempDir();
  try {
    const r = await run(dir, ['check']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.split('\n').length, 1);
    assert.match(r.stderr, /intent init/);
  } finally {
    cleanup(dir);
  }
});

test('check: known fixture scores every penalty kind exactly', async () => {
  const root = fixture();
  try {
    const { code, report } = await checkJson(root);
    assert.equal(code, 0);
    const got = Object.fromEntries(report.penalties.map((p) => [p.kind, [p.count, p.penalty, p.cap]]));
    assert.deepEqual(got, {
      uncoveredAreas: [2, 20, 40],
      drift: [1, 3, 20],
      overdue: [1, 2, 10],
      deadGoverns: [1, 2, 10],
      staleProposed: [1, 1, 5],
      missingWhy: [1, 1, 10],
      unreachable: [1, 0.5, 5],
      problems: [2, 6, 10],
      rules: [1, 5, 10],
    });
    // 100 - 40.5 = 59.5, rounded once at the end.
    assert.equal(report.score, 60);
    assert.equal(report.driftChecked, true);
    assert.deepEqual(report.totals, { records: 9, active: 7, modules: 1, areas: 4 });

    const f = report.findings;
    assert.deepEqual(f.uncoveredAreas, [{ area: 'src/payments', files: 1, proposed: [] }, { area: 'src/search', files: 1, proposed: ['root/0003'] }], 'a proposal is not coverage, but is named');
    assert.deepEqual(f.coveredAreas.map((a) => a.area), ['src/auth', 'src/billing']);
    assert.deepEqual(f.coveredAreas.find((a) => a.area === 'src/billing').modules, ['billing']);
    assert.deepEqual(f.drift, [{
      id: 'billing/0001', path: 'modules/billing/decisions/0001-refunds.md', module: 'billing', date: '2026-09-01',
      total: 1, files: [{ file: 'src/billing/refunds/r.ts', changed: '2026-10-05' }],
    }]);
    assert.deepEqual(f.overdue.map((r) => [r.id, r.reviewDate]), [['billing/0001', '2026-10-01']]);
    assert.deepEqual(f.deadGoverns, [{ id: 'billing/0002', path: 'modules/billing/decisions/0002-ledger.md', module: 'billing', pattern: 'src/billing/ledger/**' }]);
    assert.deepEqual(f.staleProposed.map((r) => [r.id, r.days]), [['root/0003', 56]]);
    assert.deepEqual(f.missingWhy.map((r) => r.id), ['billing/0002']);
    assert.deepEqual(f.unreachable.map((r) => r.id), ['root/0002']);
    assert.deepEqual(f.problems.map((p) => p.kind).sort(), ['duplicate-id', 'unresolved-ref']);
    assert.deepEqual(f.rules, [{ file: 'AGENTS.md', state: 'no-file' }]);
    assert.deepEqual(f.unknownStatus, []);

    const human = await run(root, ['check']);
    assert.equal(human.code, 0);
    const lines = human.stdout.split('\n');
    assert.equal(lines[0], 'Intent debt: 60/100');
    assert.ok(lines.includes('  Uncovered code areas: 2 of 4 (-20)'));
    assert.ok(lines.includes('  Drift (governed files changed after the record date): 1 (-3)'));
    assert.ok(lines.includes('  Unreachable records (nothing points an agent at them): 1 (-0.5)'));
    assert.ok(lines.includes('  billing/0001 (2026-09-01): 1 changed since, latest src/billing/refunds/r.ts on 2026-10-05'));
    assert.ok(lines.includes('  AGENTS.md: file missing'));
    assert.ok(!human.stdout.includes('Drift not checked'));
    assert.equal(lines.at(-1), 'Biggest gap: 2 uncovered areas. src/search has a proposal waiting: ask the human to confirm it, then: intent accept root/0003');
  } finally {
    cleanup(root);
  }
});

test('check: every penalty stops at its cap and the score clamps at 0', async () => {
  const files = {
    'src/a/x.ts': '', 'src/b/x.ts': '', 'src/c/x.ts': '', 'src/d/x.ts': '',
    'AGENTS.md': '# Notes\n', 'CLAUDE.md': '# Notes\n', 'GEMINI.md': '# Notes\n',
    [`${V}/modules/gone/gone.md`]: moduleNote('gone', [1, 2, 3, 4, 5, 6].map((n) => `src/gone${n}/**`)),
  };
  let n = 0;
  const add = (opts) => {
    n++;
    const num = String(n).padStart(4, '0');
    files[`${V}/decisions/${num}-r.md`] = record({ id: num, title: `Rule ${n}`, ...opts });
  };
  for (let i = 0; i < 7; i++) add({ governs: ['src/a/**'] }); // drift
  for (let i = 0; i < 14; i++) add({ why: TODO_WHY, review_date: '2026-01-01' }); // unreachable, no why, overdue
  for (let i = 0; i < 6; i++) add({ status: 'proposed', date: '2026-01-01', governs: ['src/a/**'] }); // stale
  add({ status: 'proposed', date: '2026-10-26', governs: ['src/a/**'], supersedes: ['nope1', 'nope2', 'nope3', 'nope4'] });
  const root = makeRepo(files, { git: true, config: { rulesFiles: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] } });
  try {
    commitAll(root, 'initial', '2026-08-01');
    writeTree(root, { 'src/a/x.ts': 'changed\n' });
    commitAll(root, 'change a', '2026-10-01');

    const { report } = await checkJson(root);
    const got = Object.fromEntries(report.penalties.map((p) => [p.kind, [p.count, p.penalty]]));
    assert.deepEqual(got, {
      uncoveredAreas: [3, 30],
      drift: [7, 20],
      overdue: [14, 10],
      deadGoverns: [6, 10],
      staleProposed: [6, 5],
      missingWhy: [14, 10],
      unreachable: [14, 5],
      problems: [4, 10],
      rules: [3, 10],
    });
    assert.equal(report.score, 0);

    const human = await run(root, ['check']);
    assert.match(human.stdout, /^Intent debt: 0\/100$/m);
    assert.match(human.stdout, /^ {2}Drift \(governed files changed after the record date\): 7 \(-20, capped\)$/m);
    assert.match(human.stdout, /^ {2}Uncovered code areas: 3 of 4 \(-30\)$/m);
  } finally {
    cleanup(root);
  }
});

test('check: a repo with no debt scores 100', async () => {
  const root = makeRepo({
    'src/billing/a.ts': '',
    [`${V}/modules/billing/billing.md`]: moduleNote('billing', ['src/billing/**']),
    [`${V}/modules/billing/decisions/0001-a.md`]: record({ id: '0001', title: 'Amounts are integer cents', governs: ['src/billing/**'], review_date: '2027-04-01' }),
  });
  try {
    applyRules(loadContext(root));
    const { report } = await checkJson(root);
    assert.equal(report.score, 100);
    assert.ok(report.penalties.every((p) => p.count === 0 && p.penalty === 0));
    const human = await run(root, ['check', '--min', '100']);
    assert.equal(human.code, 0);
    assert.equal(human.stdout.split('\n')[0], 'Intent debt: 100/100');
    assert.equal(human.stdout.split('\n').at(-1), 'No intent debt found.');
  } finally {
    cleanup(root);
  }
});

test('check: drift counts only commits strictly after the record date', async () => {
  const files = {
    'src/a/old.ts': '',
    'src/b/x.ts': '',
    'src/c/x.ts': '',
    [`${V}/modules/a/decisions/0001-a.md`]: record({ id: '0001', title: 'A rule', governs: ['src/a/**'], date: '2026-09-01' }),
    // no governs of its own: the module note's governs are what an agent follows
    [`${V}/modules/b/b.md`]: moduleNote('b', ['src/b/**']),
    [`${V}/modules/b/decisions/0001-b.md`]: record({ id: '0001', title: 'B rule', date: '2026-09-01' }),
    // superseded history does not drift; its replacement is newer than the change
    [`${V}/modules/c/decisions/0001-old.md`]: record({ id: '0001', title: 'Old C rule', governs: ['src/c/**'], date: '2026-06-01' }),
    [`${V}/modules/c/decisions/0002-new.md`]: record({ id: '0002', title: 'New C rule', governs: ['src/c/**'], date: '2026-10-10', supersedes: ['0001'] }),
    // proposed records and undated records are not checked
    [`${V}/modules/a/decisions/0002-p.md`]: record({ id: '0002', title: 'Proposed A rule', status: 'proposed', governs: ['src/a/**'], date: '2026-09-01' }),
    [`${V}/modules/a/decisions/0003-undated.md`]: record({ id: '0003', title: 'Undated', governs: ['src/a/**'] }).replace('date: 2026-09-01\n', ''),
  };
  const root = makeRepo(files, { git: true });
  try {
    commitAll(root, 'initial', '2026-08-01');
    writeTree(root, { 'src/a/same.ts': '' });
    commitAll(root, 'same day', '2026-09-01');
    writeTree(root, { 'src/a/new.ts': '', 'src/b/x.ts': 'changed\n' });
    commitAll(root, 'later', '2026-10-01');
    writeTree(root, { 'src/c/x.ts': 'changed\n' });
    commitAll(root, 'c', '2026-10-03');
    writeTree(root, { 'src/a/uncommitted.ts': '' }); // only commits count

    const { report } = await checkJson(root);
    assert.deepEqual(report.findings.drift.map((d) => [d.id, d.total, d.files]), [
      ['a/0001', 1, [{ file: 'src/a/new.ts', changed: '2026-10-01' }]],
      ['b/0001', 1, [{ file: 'src/b/x.ts', changed: '2026-10-01' }]],
    ]);
    assert.equal(penalty(report, 'drift').penalty, 6);
  } finally {
    cleanup(root);
  }
});

test('check: a drift finding lists at most 10 files, newest first, with the total', async () => {
  const files = { [`${V}/modules/g/decisions/0001-g.md`]: record({ id: '0001', title: 'G rule', governs: ['src/g/**'] }) };
  for (let i = 1; i <= 12; i++) files[`src/g/f${String(i).padStart(2, '0')}.ts`] = '';
  const root = makeRepo(files, { git: true });
  try {
    commitAll(root, 'initial', '2026-08-01');
    writeTree(root, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`src/g/f${String(i + 1).padStart(2, '0')}.ts`, 'x'])));
    commitAll(root, 'change', '2026-10-01');
    writeTree(root, { 'src/g/f12.ts': 'y' });
    commitAll(root, 'change again', '2026-10-02');

    const [d] = analyzeRepo(root, { git: true }).findings.drift;
    assert.equal(d.total, 12);
    assert.equal(d.files.length, 10);
    assert.deepEqual(d.files[0], { file: 'src/g/f12.ts', changed: '2026-10-02' });
    assert.deepEqual(d.files.slice(1).map((x) => x.file), ['f01', 'f02', 'f03', 'f04', 'f05', 'f06', 'f07', 'f08', 'f09'].map((x) => `src/g/${x}.ts`));
  } finally {
    cleanup(root);
  }
});

test('check: outside git, drift is not checked and the report says so', async () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    [`${V}/decisions/0001-a.md`]: record({ id: '0001', title: 'A rule', governs: ['src/a/**'], date: '2020-01-01' }),
  });
  try {
    const { report } = await checkJson(root);
    assert.equal(report.driftChecked, false);
    assert.deepEqual(report.findings.drift, []);
    assert.equal(penalty(report, 'drift').count, 0);
    const human = await run(root, ['check']);
    assert.ok(human.stdout.split('\n').includes('Drift not checked: not a git repo.'));
  } finally {
    cleanup(root);
  }
});

test('check: code areas follow codeRoots and areaDepth; empty and missing roots are skipped', () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    'src/b/y.ts': '',
    'src/index.ts': '',
    'lib/util.ts': '', // a root with no sub-folders is one area
    'tools/one/deep/z.ts': '',
    'tools/two/w.ts': '',
    [`${V}/modules/a/a.md`]: moduleNote('a', ['src/a/**']),
    [`${V}/decisions/0001-lib.md`]: record({ id: '0001', title: 'Lib has no state', governs: ['lib/**'] }),
    [`${V}/decisions/0002-b.md`]: record({ id: '0002', title: 'B is pure' }).replace('Some context.', 'See `src/b/y.ts`.'),
    [`${V}/decisions/0003-b.md`]: record({ id: '0003', title: 'B is cached', status: 'proposed', governs: ['src/b/**'] }),
    [`${V}/decisions/0004-b.md`]: record({ id: '0004', title: 'B was sync', status: 'superseded', governs: ['src/b/**'] }),
  }, { config: { codeRoots: ['src', 'lib', 'missing', './tools/'] } });
  try {
    mkdirSync(join(root, 'src/empty/inner'), { recursive: true });
    const ctx = loadContext(root);
    assert.deepEqual(areaFolders(ctx), ['lib', 'src/a', 'src/b', 'src/empty', 'tools/one', 'tools/two']);
    const report = analyzeRepo(root);
    assert.equal(report.totals.areas, 5, 'src/empty has no files');
    assert.deepEqual(report.findings.coveredAreas.map((a) => a.area), ['lib', 'src/a']);
    // a mention, a proposed record and a superseded record do not cover src/b
    assert.deepEqual(report.findings.uncoveredAreas, [{ area: 'src/b', files: 1, proposed: ['root/0003'] }, { area: 'tools/one', files: 1, proposed: [] }, { area: 'tools/two', files: 1, proposed: [] }]);
    assert.equal(penalty(report, 'uncoveredAreas').penalty, 24);

    writeFileSync(join(root, '.intent.json'), JSON.stringify({ version: 1, codeRoots: ['tools'], areaDepth: 2 }));
    assert.deepEqual(areaFolders(loadContext(root)), ['tools/one/deep', 'tools/two']);
  } finally {
    cleanup(root);
  }
});

test('check: no code areas means no coverage penalty', () => {
  const root = makeRepo({ 'README.md': '# x\n' }, { config: { codeRoots: ['src'] } });
  try {
    const report = analyzeRepo(root);
    assert.equal(report.totals.areas, 0);
    assert.equal(penalty(report, 'uncoveredAreas').penalty, 0);
    assert.equal(report.score, 95, 'only the missing AGENTS.md');
  } finally {
    cleanup(root);
  }
});

test('check: review dates, proposal age and missing why use the right boundaries', () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    [`${V}/decisions/0001-today.md`]: record({ id: '0001', title: 'Due today', governs: ['src/a/**'], review_date: '2026-10-27' }),
    [`${V}/decisions/0002-yesterday.md`]: record({ id: '0002', title: 'Due yesterday', governs: ['src/a/**'], review_date: '2026-10-26' }),
    [`${V}/decisions/0003-history.md`]: record({ id: '0003', title: 'Old and replaced', governs: ['src/a/**'], review_date: '2026-01-01', why: TODO_WHY }),
    [`${V}/decisions/0004-new.md`]: record({ id: '0004', title: 'Replacement', governs: ['src/a/**'], supersedes: ['0003'] }),
    [`${V}/decisions/0005-p14.md`]: record({ id: '0005', title: 'Fourteen days', status: 'proposed', date: '2026-10-13', governs: ['src/a/**'], why: TODO_WHY }),
    [`${V}/decisions/0006-p15.md`]: record({ id: '0006', title: 'Fifteen days', status: 'proposed', date: '2026-10-12', governs: ['src/a/**'], why: TODO_WHY }),
    [`${V}/decisions/0007-nowhy.md`]: record({ id: '0007', title: 'No why yet', governs: ['src/a/**'], why: TODO_WHY }),
    [`${V}/decisions/0008-empty.md`]: record({ id: '0008', title: 'Empty why', governs: ['src/a/**'], why: '' }),
    [`${V}/decisions/0009-dep.md`]: record({ id: '0009', title: 'Dropped', status: 'deprecated', governs: ['src/a/**'], review_date: '2026-01-01', why: TODO_WHY }),
  });
  try {
    const f = analyzeRepo(root).findings;
    assert.deepEqual(f.overdue.map((r) => r.id), ['root/0002']);
    assert.deepEqual(f.staleProposed.map((r) => [r.id, r.days]), [['root/0006', 15]]);
    assert.deepEqual(f.missingWhy.map((r) => r.id), ['root/0007', 'root/0008']);

    writeFileSync(join(root, '.intent.json'), JSON.stringify({ version: 1, proposedMaxDays: 30 }));
    assert.deepEqual(analyzeRepo(root).findings.staleProposed, []);
  } finally {
    cleanup(root);
  }
});

test('check: dead governs covers records and module notes, not history', () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    'src/a/y.ts': '',
    [`${V}/modules/a/a.md`]: moduleNote('a', ['src/a/**', 'src/a/gone.ts']),
    [`${V}/modules/a/decisions/0001-live.md`]: record({ id: '0001', title: 'Live', governs: ['src/a/x.ts', 'src/a/*.md', 'src/a'] }),
    [`${V}/modules/a/decisions/0002-p.md`]: record({ id: '0002', title: 'Proposed', status: 'proposed', date: '2026-10-25', governs: ['src/b/**'] }),
    [`${V}/modules/a/decisions/0003-old.md`]: record({ id: '0003', title: 'Old', status: 'superseded', governs: ['src/old/**'] }),
    [`${V}/modules/a/decisions/0004-dep.md`]: record({ id: '0004', title: 'Dropped', status: 'deprecated', governs: ['src/dropped/**'] }),
  });
  try {
    const f = analyzeRepo(root).findings;
    assert.deepEqual(f.deadGoverns.map((d) => [d.id || `module:${d.module}`, d.pattern]), [
      ['a/0001', 'src/a/*.md'],
      ['a/0002', 'src/b/**'],
      ['module:a', 'src/a/gone.ts'],
    ]);
  } finally {
    cleanup(root);
  }
});

test('check: unreachable means no governs and no module note with governs', () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    [`${V}/modules/a/a.md`]: moduleNote('a', ['src/a/**']),
    [`${V}/modules/a/decisions/0001-a.md`]: record({ id: '0001', title: 'Reached by module' }),
    [`${V}/modules/n/n.md`]: moduleNote('n', []),
    [`${V}/modules/n/decisions/0001-n.md`]: record({ id: '0001', title: 'Module without governs' }),
    [`${V}/modules/q/decisions/0001-q.md`]: record({ id: '0001', title: 'No module note' }),
    [`${V}/decisions/0001-root.md`]: record({ id: '0001', title: 'Cross-cutting, nowhere' }),
    [`${V}/decisions/0002-root.md`]: record({ id: '0002', title: 'Cross-cutting, governed', governs: ['src/**'] }),
    [`${V}/decisions/0003-root.md`]: record({ id: '0003', title: 'Proposed, nowhere', status: 'proposed', date: '2026-10-25' }),
  });
  try {
    const report = analyzeRepo(root);
    assert.deepEqual(report.findings.unreachable.map((r) => r.id), ['n/0001', 'q/0001', 'root/0001']);
    assert.equal(penalty(report, 'unreachable').penalty, 1.5);
  } finally {
    cleanup(root);
  }
});

test('check: rules block — AGENTS.md is expected, CLAUDE.md only when it exists', () => {
  const root = makeRepo({ 'src/a/x.ts': '' });
  try {
    const ctx = loadContext(root);
    assert.deepEqual(analyzeRepo(root).findings.rules, [{ file: 'AGENTS.md', state: 'no-file' }]);
    applyRules(ctx);
    assert.equal(exists(root, 'CLAUDE.md'), false);
    assert.deepEqual(analyzeRepo(root).findings.rules, []);
    writeTree(root, { 'CLAUDE.md': '# Claude notes\n' });
    assert.deepEqual(analyzeRepo(root).findings.rules, [{ file: 'CLAUDE.md', state: 'missing' }]);
    writeTree(root, { 'AGENTS.md': read(root, 'AGENTS.md').replace('Every agent follows', 'Agents follow') });
    const report = analyzeRepo(root);
    assert.deepEqual(report.findings.rules, [{ file: 'AGENTS.md', state: 'outdated' }, { file: 'CLAUDE.md', state: 'missing' }]);
    assert.equal(penalty(report, 'rules').penalty, 10);
  } finally {
    cleanup(root);
  }
});

test('check: unknown statuses are listed, count as active, and cost nothing by themselves', async () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    [`${V}/decisions/0001-a.md`]: record({ id: '0001', title: 'Odd status', status: 'banana', governs: ['src/a/**'] }),
  });
  try {
    applyRules(loadContext(root));
    const { report } = await checkJson(root);
    assert.deepEqual(report.findings.unknownStatus, [{ id: 'root/0001', path: 'decisions/0001-a.md', statusRaw: 'banana' }]);
    assert.equal(report.totals.active, 1);
    assert.equal(report.score, 100);
    const human = await run(root, ['check']);
    assert.match(human.stdout, /^ {2}root\/0001: status "banana"$/m);
  } finally {
    cleanup(root);
  }
});

test('check: --min exits 1 below the score and still prints the report', async () => {
  const root = fixture();
  try {
    const below = await run(root, ['check', '--min', '61']);
    assert.equal(below.code, 1);
    assert.match(below.stdout, /^Intent debt: 60\/100$/m);
    assert.equal((await run(root, ['check', '--min', '60'])).code, 0);
    assert.equal((await run(root, ['check', '--min=0'])).code, 0);
    const json = await checkJson(root, ['--min', '90']);
    assert.equal(json.code, 1);
    assert.equal(json.report.score, 60);
    for (const bad of [['--min', 'abc'], ['--min']]) {
      const r = await run(root, ['check', ...bad]);
      assert.equal(r.code, 2);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /--min needs a number/);
    }
  } finally {
    cleanup(root);
  }
});

test('check: --json is a single document equal to analyze()', async () => {
  const root = fixture();
  try {
    const { stdout, report } = await checkJson(root);
    assert.equal(stdout.trim()[0], '{');
    assert.deepEqual(report, JSON.parse(JSON.stringify(analyzeRepo(root, { git: true }))));
    assert.deepEqual(Object.keys(report.findings).sort(), [
      'coveredAreas', 'deadGoverns', 'drift', 'missingWhy', 'overdue', 'problems', 'rules',
      'staleProposed', 'uncoveredAreas', 'unknownStatus', 'unreachable',
    ]);
  } finally {
    cleanup(root);
  }
});

test('check: read-only — files are the truth, nothing is written, a stale index is ignored', async () => {
  const root = fixture();
  try {
    writeTree(root, { [`${V}/index.json`]: { version: 1, records: [{ id: 'ghost/0001', effectiveStatus: 'accepted', governs: [] }], modules: [], problems: [] } });
    const before = snapshot(root);
    const human = await run(root, ['check']);
    const { report } = await checkJson(root, ['--min', '99']);
    assert.deepEqual(snapshot(root), before);
    assert.equal(report.totals.records, 9);
    assert.ok(!human.stdout.includes('ghost'));
    // the why of a record with no rationale stays the TODO marker
    assert.match(read(root, `${V}/modules/billing/decisions/0002-ledger.md`), new RegExp(TODO_WHY.replace(/[.?]/g, '\\$&')));
  } finally {
    cleanup(root);
  }
});

test('check: long sections stop at 20 lines', async () => {
  const files = {};
  for (let i = 1; i <= 25; i++) files[`src/m${String(i).padStart(2, '0')}/x.ts`] = '';
  const root = makeRepo(files);
  try {
    const { stdout } = await run(root, ['check']);
    const lines = stdout.split('\n');
    const at = lines.indexOf('Uncovered code areas:');
    assert.ok(at > 0);
    assert.equal(lines[at + 1], '  src/m01 (1 file)');
    assert.equal(lines[at + 20], '  src/m20 (1 file)');
    assert.equal(lines[at + 21], '  ... and 5 more');
    assert.equal(lines.at(-1), 'Biggest gap: 25 uncovered areas. Record intent: intent new m01 "<the rule>" --governs src/m01/**');
  } finally {
    cleanup(root);
  }
});

test('check: the hint names the fix for the biggest penalty', async () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    [`${V}/modules/a/a.md`]: moduleNote('a', ['src/a/**']),
    [`${V}/modules/a/decisions/0001-a.md`]: record({ id: '0001', title: 'A', governs: ['src/a/**'] }),
  });
  try {
    const last = async () => (await run(root, ['check'])).stdout.split('\n').at(-1);
    assert.equal(await last(), 'Biggest gap: 1 rules file needs the block. Run: intent rules');
    applyRules(loadContext(root));
    writeTree(root, {
      [`${V}/modules/a/decisions/0002-b.md`]: record({ id: '0002', title: 'B', governs: ['src/a/**'], why: TODO_WHY }),
      [`${V}/modules/a/decisions/0003-c.md`]: record({ id: '0003', title: 'C', governs: ['src/a/**'], why: TODO_WHY }),
    });
    assert.equal(await last(), 'Biggest gap: 2 records have no why. Ask the human why (do not guess), then: intent new a "<the rule>" --supersedes a/0002 --why "<their words>"');
    writeTree(root, { [`${V}/modules/a/decisions/0004-d.md`]: record({ id: '0004', title: 'D', status: 'proposed', date: '2026-01-01', governs: ['src/a/**'], supersedes: ['missing'] }) });
    assert.equal(await last(), 'Biggest gap: 1 ID problem. supersedes "missing" does not match any record (intent-vault/modules/a/decisions/0004-d.md). Fix the files, then run: intent index');
  } finally {
    cleanup(root);
  }
});

test('check: a rules file with broken markers counts, and the hint says to fix it by hand', async () => {
  const root = makeRepo({
    'src/a/x.ts': '',
    [`${V}/modules/a/a.md`]: moduleNote('a', ['src/a/**']),
    [`${V}/modules/a/decisions/0001-a.md`]: record({ id: '0001', title: 'A', governs: ['src/a/**'] }),
  }, { config: { rulesFiles: ['AGENTS.md'] } });
  try {
    applyRules(loadContext(root));
    const block = read(root, 'AGENTS.md');
    writeTree(root, { 'AGENTS.md': `${block}\n${block}` });
    const report = analyzeRepo(root);
    assert.deepEqual(report.findings.rules, [{ file: 'AGENTS.md', state: 'ok', broken: '2 start and 2 end markers' }]);
    assert.equal(penalty(report, 'rules').penalty, 5);
    const out = (await run(root, ['check'])).stdout;
    assert.match(out, /^ {2}AGENTS\.md: broken markers \(2 start and 2 end markers\), fix them by hand$/m);
    assert.equal(out.split('\n').at(-1), 'Biggest gap: 1 rules file needs the block. Fix the intent-compass markers in AGENTS.md by hand, then run: intent rules');
  } finally {
    cleanup(root);
  }
});

test('check: an uncovered area with a waiting proposal points at intent accept, not intent new', async () => {
  const root = makeRepo({
    'src/catalog/list.ts': '',
    'src/shipping/rates.ts': '',
    [`${V}/decisions/0001-captured-src-shipping.md`]: record({ id: '0001', title: 'TODO: name it', status: 'proposed', date: '2026-10-27', governs: ['src/shipping/**'], why: TODO_WHY }),
  });
  try {
    applyRules(loadContext(root));
    const out = (await run(root, ['check'])).stdout;
    assert.match(out, /^ {2}src\/shipping \(1 file; waiting for intent accept: root\/0001\)$/m);
    assert.match(out, /^ {2}src\/catalog \(1 file\)$/m);
    assert.equal(out.split('\n').at(-1), 'Biggest gap: 2 uncovered areas. src/shipping has a proposal waiting: ask the human to confirm it, then: intent accept root/0001');
  } finally {
    cleanup(root);
  }
});
