import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, run, read, exists, cleanup, record, moduleNote, tempDir, writeTree } from './helpers.mjs';
import { splitFrontmatter, sections } from '../src/fm.mjs';
import { TODO_WHY } from '../src/vault.mjs';

const V = 'intent-vault';

function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out[child] = readFileSync(join(dir, child), 'utf8');
    }
  };
  walk('');
  return out;
}

const indexOf = (root) => JSON.parse(read(root, `${V}/index.json`));
const rec = (root, id) => indexOf(root).records.find((r) => r.id === id);

// The text outside the generated region of a note.
function outsideRegion(text, name = 'decisions') {
  const a = text.indexOf(`<!-- intent:generated:${name}:start -->`);
  const b = text.indexOf(`<!-- intent:generated:${name}:end -->`);
  return text.slice(0, a) + text.slice(b);
}

function shop(extra = {}) {
  return makeRepo({
    'src/billing/refunds/refund.ts': '',
    'src/payments/charge.ts': '',
    ...extra,
  });
}

// ---------- intent new ----------

test('new: writes a proposed record with an allocated id, a module note, and refreshes the index', async () => {
  const root = shop();
  try {
    const r = await run(root, ['new', 'billing', 'Refunds go back to the original payment method', '--governs', 'src/billing/refunds/**']);
    assert.equal(r.code, 0, r.stderr);
    const rel = `${V}/modules/billing/decisions/0001-refunds-go-back-to-the-original-payment-method.md`;
    assert.match(r.stdout, /^Created billing\/0001 \(proposed\): intent-vault\/modules\/billing\/decisions\/0001-refunds-go-back-to-the-original-payment-method\.md$/m);
    assert.match(r.stdout, /Created module note: intent-vault\/modules\/billing\/billing\.md/);
    const text = read(root, rel);
    const { data, body } = splitFrontmatter(text);
    assert.deepEqual(data, {
      id: 'billing/0001', title: 'Refunds go back to the original payment method', status: 'proposed', date: '2026-10-27',
      module: 'billing', governs: ['src/billing/refunds/**'], provenance: 'human', review_date: '2027-04-27', supersedes: [], tags: [],
    });
    const s = sections(body);
    assert.equal(s.get(/^Decision$/), 'Refunds go back to the original payment method');
    assert.equal(s.get(/^Why/), TODO_WHY, 'never invent a rationale');
    for (const h of [/^Context$/, /^Alternatives/, /^Consequences$/]) assert.equal(s.get(h), 'TODO');

    const note = read(root, `${V}/modules/billing/billing.md`);
    const nd = splitFrontmatter(note).data;
    assert.deepEqual(nd, { type: 'module', module: 'billing', governs: ['src/billing/refunds/**'] });
    assert.match(note, /<!-- intent:generated:decisions:start -->[\s\S]*\[\[modules\/billing\/decisions\/0001-refunds-go-back-to-the-original-payment-method\|billing\/0001\]\][\s\S]*<!-- intent:generated:decisions:end -->/);

    const r1 = rec(root, 'billing/0001');
    assert.equal(r1.status, 'proposed');
    assert.equal(r1.missingWhy, true);
  } finally {
    cleanup(root);
  }
});

test('new: numbers come from the namespace; root records go to decisions/', async () => {
  const root = shop({
    [`${V}/modules/billing/billing.md`]: moduleNote('billing', ['src/billing/**']),
    [`${V}/modules/billing/decisions/0001-a.md`]: record({ id: 'billing/0001', title: 'A' }),
    [`${V}/modules/billing/decisions/0007-b.md`]: record({ id: 'billing/0007', title: 'B' }),
    [`${V}/decisions/0002-c.md`]: record({ id: 'root/0002', title: 'C' }),
  });
  try {
    const a = await run(root, ['new', 'billing', 'Invoices are immutable', '--json']);
    assert.equal(a.code, 0, a.stderr);
    assert.deepEqual(JSON.parse(a.stdout), { id: 'billing/0008', path: `${V}/modules/billing/decisions/0008-invoices-are-immutable.md` });
    const b = await run(root, ['new', 'root', 'All money is integer cents', '--json']);
    assert.deepEqual(JSON.parse(b.stdout), { id: 'root/0003', path: `${V}/decisions/0003-all-money-is-integer-cents.md` });
    assert.equal(splitFrontmatter(read(root, `${V}/decisions/0003-all-money-is-integer-cents.md`)).data.module, undefined);
    const c = await run(root, ['new', 'payments', 'Charges carry an idempotency key', '--json']);
    assert.equal(JSON.parse(c.stdout).id, 'payments/0001');
  } finally {
    cleanup(root);
  }
});

test('new: an existing module note is only touched inside its generated region', async () => {
  const note = moduleNote('billing', ['src/billing/**']).replace('# billing\n', '# billing\nHand-written: refunds are audited by finance.\n');
  const root = shop({ [`${V}/modules/billing/billing.md`]: note });
  try {
    const r = await run(root, ['new', 'billing', 'Refunds are audited', '--governs', 'src/other/**']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Created module note/);
    const after = read(root, `${V}/modules/billing/billing.md`);
    assert.equal(outsideRegion(after), outsideRegion(note), 'governs and free text unchanged');
    assert.match(after, /billing\/0001/);
  } finally {
    cleanup(root);
  }
});

test('new: every flag lands verbatim; nothing else is made up', async () => {
  const root = shop();
  try {
    const r = await run(root, [
      'new', 'payments', 'Charges', 'carry', 'an', 'idempotency', 'key',
      '--governs', 'src/payments/**, src/payments/charge.ts',
      '--why', 'The fictional Larkspur pilot saw double charges on retry.',
      '--context', 'Retries happen on mobile.',
      '--decision', 'Every charge request carries a client key.',
      '--alternatives', 'Server-side dedupe by amount.',
      '--consequences', 'Clients must persist the key.',
      '--status', 'accepted', '--provenance', 'imported', '--review', '2027-01-15', '--tags', 'payments,reliability',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.doesNotMatch(r.stdout, /Why: TODO/);
    const text = read(root, `${V}/modules/payments/decisions/0001-charges-carry-an-idempotency-key.md`);
    const { data, body } = splitFrontmatter(text);
    assert.equal(data.title, 'Charges carry an idempotency key');
    assert.equal(data.status, 'accepted');
    assert.equal(data.provenance, 'imported');
    assert.equal(data.review_date, '2027-01-15');
    assert.deepEqual(data.governs, ['src/payments/**', 'src/payments/charge.ts']);
    assert.deepEqual(data.tags, ['payments', 'reliability']);
    const s = sections(body);
    assert.equal(s.get(/^Why/), 'The fictional Larkspur pilot saw double charges on retry.');
    assert.equal(s.get(/^Context$/), 'Retries happen on mobile.');
    assert.equal(s.get(/^Decision$/), 'Every charge request carries a client key.');
    assert.equal(s.get(/^Alternatives/), 'Server-side dedupe by amount.');
    assert.equal(s.get(/^Consequences$/), 'Clients must persist the key.');
  } finally {
    cleanup(root);
  }
});

test('new: provenance defaults to ai-suggested for agents; review months come from config', async () => {
  const root = shop();
  const short = makeRepo({}, { config: { reviewMonths: 3 } });
  try {
    for (const env of [{ CLAUDECODE: '1' }, { INTENT_AGENT: 'codex' }]) {
      const r = await run(root, ['new', 'billing', `Rule for ${Object.keys(env)[0]}`, '--json'], { env });
      const { path } = JSON.parse(r.stdout);
      assert.equal(splitFrontmatter(read(root, path)).data.provenance, 'ai-suggested');
    }
    const r = await run(short, ['new', 'root', 'Short review', '--json']);
    assert.equal(splitFrontmatter(read(short, JSON.parse(r.stdout).path)).data.review_date, '2027-01-27');
  } finally {
    cleanup(root);
    cleanup(short);
  }
});

test('new: bad input is refused and nothing is written', async () => {
  const root = shop({ [`${V}/decisions/0001-a.md`]: record({ id: 'root/0001', title: 'A' }) });
  try {
    const before = snapshot(root);
    const cases = [
      [['new', 'Bad/Name', 'T'], 1, /invalid module name/],
      [['new', '..', 'T'], 1, /invalid module name/],
      [['new', 'billing', 'T', '--status', 'superseded'], 1, /--status must be one of proposed, accepted/],
      [['new', 'billing', 'T', '--provenance', 'guess'], 1, /--provenance must be one of/],
      [['new', 'billing', 'T', '--review', '2027-02-30'], 1, /--review must be a date/],
      [['new', 'billing', 'T', '--supersedes', '9'], 1, /--supersedes 9 does not match any record/],
      [['new', 'billing', 'T', '--supersedes', 'root/0001,billing/0002'], 1, /billing\/0002 does not match/],
      [['new', 'billing', 'T', '--governs', '../outside/**'], 1, /not a path inside the repo/],
      [['new', 'billing', 'T', '--governs', '/'], 1, /not a path inside the repo/],
      [['new', 'billing', 'T', '--why'], 2, /--why needs a value/],
      [['new', 'billing'], 2, /^usage: intent new MODULE/],
      [['new'], 2, /^usage: intent new MODULE/],
    ];
    for (const [argv, code, re] of cases) {
      const r = await run(root, argv);
      assert.equal(r.code, code, argv.join(' '));
      assert.match(r.stderr, re, argv.join(' '));
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('new: never overwrites; a number taken on disk but not in the index is skipped', async () => {
  const root = shop();
  try {
    // Something already sits at the path the index would allocate (another writer, a stray folder).
    mkdirSync(join(root, V, 'modules/billing/decisions/0001-refunds-are-final.md'), { recursive: true });
    const r = await run(root, ['new', 'billing', 'Refunds are final', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { id: 'billing/0002', path: `${V}/modules/billing/decisions/0002-refunds-are-final.md` });
    assert.ok(statSync(join(root, V, 'modules/billing/decisions/0001-refunds-are-final.md')).isDirectory(), 'left as it was');
  } finally {
    cleanup(root);
  }
});

test('new --supersedes: id forms resolve; the old file is never edited; supersede is derived', async () => {
  const old = record({ id: 'billing/0003', title: 'Refunds become store credit', governs: ['src/billing/refunds/**'] });
  const cross = record({ id: 'root/0001', title: 'Money is floats' });
  const root = shop({
    [`${V}/modules/billing/billing.md`]: moduleNote('billing', ['src/billing/**']),
    [`${V}/modules/billing/decisions/0003-store-credit.md`]: old,
    [`${V}/decisions/0001-money.md`]: cross,
  });
  try {
    for (const form of ['3', 'billing/0003', 'billing/3', 'billing 0003']) {
      const r = await run(root, ['new', 'billing', `Proposal via ${form}`, '--supersedes', form, '--json']);
      assert.equal(r.code, 0, `${form}: ${r.stderr}`);
      assert.deepEqual(splitFrontmatter(read(root, JSON.parse(r.stdout).path)).data.supersedes, ['billing/0003'], form);
    }
    // Proposed replacements leave the old record in force.
    assert.equal(rec(root, 'billing/0003').effectiveStatus, 'accepted');
    assert.equal(rec(root, 'billing/0003').pendingReplacements.length, 4);

    const r = await run(root, ['new', 'billing', 'Refunds go to the original method', '--supersedes', 'billing/0003,root/0001', '--status', 'accepted', '--why', 'Finance asked for it.', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const { id } = JSON.parse(r.stdout);
    assert.equal(rec(root, 'billing/0003').effectiveStatus, 'superseded');
    assert.deepEqual(rec(root, 'billing/0003').supersededBy, [id]);
    assert.equal(rec(root, 'root/0001').effectiveStatus, 'superseded');
    assert.equal(read(root, `${V}/modules/billing/decisions/0003-store-credit.md`), old, 'append-only');
    assert.equal(read(root, `${V}/decisions/0001-money.md`), cross, 'append-only');
  } finally {
    cleanup(root);
  }
});

test('new: vault outside the repo prints the absolute path; not opted in exits 1', async () => {
  const vault = tempDir('intent-vault-');
  const root = makeRepo({}, { config: { vault } });
  const bare = tempDir();
  try {
    const r = await run(root, ['new', 'root', 'Logs are structured', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).path, join(vault, 'decisions/0001-logs-are-structured.md'));
    const n = await run(bare, ['new', 'billing', 'T']);
    assert.equal(n.code, 1);
    assert.equal(n.stderr.split('\n').length, 1);
    assert.deepEqual(readdirSync(bare), []);
  } finally {
    cleanup(root);
    cleanup(vault);
    cleanup(bare);
  }
});

// ---------- intent accept ----------

const proposed = (id, title, extra = {}) => record({ id, title, status: 'proposed', ...extra });

test('accept: flips only the status line; every other byte stays', async () => {
  const text = proposed('billing/0002', 'Refunds are batched nightly', { governs: ['src/billing/refunds/**'] })
    .replace('status: proposed', 'status:   proposed   # waiting on finance');
  const rel = `${V}/modules/billing/decisions/0002-batched.md`;
  const root = shop({ [`${V}/modules/billing/billing.md`]: moduleNote('billing', ['src/billing/**']), [rel]: text });
  try {
    const r = await run(root, ['accept', 'billing/0002']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `Accepted billing/0002: ${rel}`);
    assert.equal(r.stderr, '');
    const after = read(root, rel);
    assert.equal(after, text.replace('status:   proposed   # waiting on finance', 'status:   accepted   # waiting on finance'), 'the inline comment stays');
    const a = after.split('\n');
    const b = text.split('\n');
    assert.equal(a.length, b.length);
    assert.deepEqual(a.filter((l) => !l.startsWith('status:')), b.filter((l) => !l.startsWith('status:')));
    assert.equal(rec(root, 'billing/0002').status, 'accepted');
    assert.match(read(root, `${V}/modules/billing/billing.md`), /billing\/0002\]\] — Refunds are batched nightly \*\(accepted\)\*/);
  } finally {
    cleanup(root);
  }
});

test('accept: body-bullet records get only their Status bullet edited (CRLF kept)', async () => {
  const bullets = '# Tokens are short-lived\r\n\r\n- Date: 2026-07-01\r\n- Status: Proposed\r\n- Module: [[auth]]\r\n\r\n## Context\r\n- Status: not this one\r\n\r\n## Why\r\nTODO\r\n';
  const bold = '# Sessions are sticky\n\n**Status:** draft\n\n## Decision\nx\n';
  const root = shop({
    [`${V}/modules/auth/decisions/0002-tokens.md`]: bullets,
    [`${V}/modules/auth/decisions/0003-sticky.md`]: bold,
  });
  try {
    const r = await run(root, ['accept', 'auth/0002', 'auth/0003']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(root, `${V}/modules/auth/decisions/0002-tokens.md`), bullets.replace('- Status: Proposed', '- Status: accepted'));
    assert.equal(read(root, `${V}/modules/auth/decisions/0003-sticky.md`), bold.replace('**Status:** draft', '**Status:** accepted'));
    assert.match(r.stderr, /warning: accepted without a recorded why: auth\/0002/);
    assert.equal(rec(root, 'auth/0002').status, 'accepted');
    assert.equal(rec(root, 'auth/0003').status, 'accepted');
  } finally {
    cleanup(root);
  }
});

test('accept: refuses any status but proposed, unknown ids and bare numbers', async () => {
  const files = {
    [`${V}/decisions/0001-a.md`]: record({ id: 'root/0001', title: 'A', status: 'accepted' }),
    [`${V}/decisions/0002-b.md`]: record({ id: 'root/0002', title: 'B', status: 'superseded' }),
    [`${V}/decisions/0003-c.md`]: record({ id: 'root/0003', title: 'C', status: 'deprecated' }),
    [`${V}/decisions/0004-d.md`]: '# No status at all\n\n## Decision\nx\n',
    [`${V}/modules/auth/decisions/0004-e.md`]: proposed('auth/0004', 'E'),
  };
  const root = shop(files);
  try {
    const before = snapshot(root);
    const r = await run(root, ['accept', 'root/0001', 'root/0002', 'root/0003', 'root/0004', 'root/0099', '4']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /root\/0001 is accepted, not proposed/);
    assert.match(r.stderr, /root\/0002 is superseded, not proposed/);
    assert.match(r.stderr, /root\/0003 is deprecated, not proposed/);
    assert.match(r.stderr, /root\/0004 is unknown, not proposed/);
    assert.match(r.stderr, /no record with id root\/0099/);
    assert.match(r.stderr, /give the full id NAMESPACE\/NNNN, not a bare number "4" \(matches: auth\/0004, root\/0004\)/);
    assert.deepEqual(snapshot(root), before, 'nothing written, not even the index');
  } finally {
    cleanup(root);
  }
});

test('accept: duplicate ids are refused with every path listed', async () => {
  const a = proposed('root/0005', 'Cache for a minute');
  const b = proposed('root/0005', 'Cache for an hour');
  const root = shop({ [`${V}/decisions/0005-minute.md`]: a, [`${V}/decisions/0005-hour.md`]: b });
  try {
    const r = await run(root, ['accept', 'root/0005']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /id root\/0005 is used by 2 records; refusing to guess: intent-vault\/decisions\/0005-hour\.md, intent-vault\/decisions\/0005-minute\.md/);
    assert.equal(read(root, `${V}/decisions/0005-minute.md`), a);
    assert.equal(read(root, `${V}/decisions/0005-hour.md`), b);
  } finally {
    cleanup(root);
  }
});

test('accept: id forms, partial failure, --json, and no file is ever deleted', async () => {
  const root = shop({
    [`${V}/modules/billing/decisions/0001-a.md`]: proposed('billing/0001', 'A'),
    [`${V}/modules/billing/decisions/0002-b.md`]: proposed('billing/0002', 'B'),
    [`${V}/modules/billing/decisions/0003-c.md`]: proposed('billing/0003', 'C', { why: TODO_WHY }),
    [`${V}/modules/billing/decisions/0004-d.md`]: record({ id: 'billing/0004', title: 'D' }),
  });
  try {
    const names = Object.keys(snapshot(root));
    const r = await run(root, ['accept', 'billing 0001', 'billing', '0002', 'billing/3', 'billing/0004', '--json']);
    assert.equal(r.code, 1);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.accepted.map((x) => x.id), ['billing/0001', 'billing/0002', 'billing/0003']);
    assert.deepEqual(doc.errors.map((x) => x.id), ['billing/0004']);
    assert.deepEqual(doc.warnings.map((x) => x.id), ['billing/0003']);
    assert.match(doc.warnings[0].message, /accepted without a recorded why/);
    const after = Object.keys(snapshot(root));
    for (const n of names) assert.ok(after.includes(n), `kept ${n}`);
    for (const id of ['billing/0001', 'billing/0002', 'billing/0003']) assert.equal(rec(root, id).status, 'accepted');
  } finally {
    cleanup(root);
  }
});

test('accept: confirming a proposed replacement makes the supersede take effect, old file untouched', async () => {
  const old = record({ id: 'billing/0001', title: 'Refunds become store credit', governs: ['src/billing/refunds/**'] });
  const root = shop({
    [`${V}/modules/billing/billing.md`]: moduleNote('billing', ['src/billing/**']),
    [`${V}/modules/billing/decisions/0001-store-credit.md`]: old,
  });
  try {
    const n = await run(root, ['new', 'billing', 'Refunds go to the original method', '--supersedes', '1', '--json']);
    const { id, path } = JSON.parse(n.stdout);
    assert.equal(rec(root, 'billing/0001').effectiveStatus, 'accepted');
    const created = read(root, path);
    const a = await run(root, ['accept', id]);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stderr, /warning: accepted without a recorded why/);
    assert.equal(read(root, path), created.replace('status: proposed', 'status: accepted'));
    assert.equal(rec(root, 'billing/0001').effectiveStatus, 'superseded');
    assert.equal(rec(root, 'billing/0001').status, 'accepted', 'old record keeps its declared status');
    assert.equal(read(root, `${V}/modules/billing/decisions/0001-store-credit.md`), old);
    const w = await run(root, ['why', 'src/billing/refunds/refund.ts', '--json']);
    assert.deepEqual(JSON.parse(w.stdout).paths[0].read, [path, `${V}/modules/billing/billing.md`]);
  } finally {
    cleanup(root);
  }
});

test('accept: usage without ids (exit 2); not opted in (exit 1)', async () => {
  const root = shop();
  const bare = tempDir();
  try {
    const u = await run(root, ['accept']);
    assert.equal(u.code, 2);
    assert.match(u.stderr, /^usage: intent accept ID/);
    const n = await run(bare, ['accept', 'root/0001']);
    assert.equal(n.code, 1);
    assert.equal(n.stderr.split('\n').length, 1);
  } finally {
    cleanup(root);
    cleanup(bare);
  }
});

test('accept: a capitalised "Status:" frontmatter key is read and flipped in place', async () => {
  const text = '---\nId: 0004\nStatus: Proposed # waiting\nTitle: Parcels ship in one box\n---\n# Parcels ship in one box\n\n## Why — the intent\n\nThe owner said split parcels get lost.\n';
  const root = shop({ [`${V}/decisions/0004-one-box.md`]: text });
  try {
    const r = await run(root, ['accept', 'root/0004']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(root, `${V}/decisions/0004-one-box.md`), text.replace('Status: Proposed # waiting', 'Status: accepted # waiting'));
  } finally {
    cleanup(root);
  }
});

test('new: a misspelled flag or a stray argument after a flag writes nothing', async () => {
  const root = shop({ [`${V}/modules/payments/decisions/0002-old.md`]: record({ id: 'payments/0002', title: 'Old' }) });
  try {
    const before = snapshot(root);
    const typo = await run(root, ['new', 'payments', 'Refunds are capped at the order total', '--governs', 'src/payments', '--supersede', 'payments/0002']);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /unknown flag --supersede \(did you mean --supersedes\?\)/);
    const spaced = await run(root, ['new', 'payments', 'Refunds go to the original card', '--governs', 'src/payments', 'src/ship', '--why', 'chargebacks']);
    assert.equal(spaced.code, 2);
    assert.match(spaced.stderr, /unexpected argument "src\/ship" after a flag/);
    const twice = await run(root, ['new', 'payments', 'T', '--why', 'a', '--why', 'b']);
    assert.equal(twice.code, 2);
    assert.match(twice.stderr, /--why given more than once/);
    const help = await run(root, ['new', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--provenance/);
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('new: repeated --governs adds up; a --why value may start with --', async () => {
  const root = shop();
  try {
    const r = await run(root, ['new', 'billing', 'No skipping hooks', '--governs', 'src/billing', '--governs', 'src/payments', '--why', '--no-verify hid a broken build last spring', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const text = read(root, JSON.parse(r.stdout).path);
    assert.match(text, /^governs: \[src\/billing, src\/payments\]$/m);
    assert.match(text, /## Why — the intent\n\n--no-verify hid a broken build last spring\n/);
    const flagsFirst = await run(root, ['new', '--json', 'billing', 'Flags may come first']);
    assert.equal(flagsFirst.code, 0, flagsFirst.stderr);
  } finally {
    cleanup(root);
  }
});

test('accept: a status with a qualifier (rejected, abandoned, pending removal) is never flipped', async () => {
  const st = (status) => `---\nid: root/0000\ntitle: T\nstatus: ${status}\n---\n# T\n\n## Why — the intent\n\nA reason.\n`;
  const statuses = ['Proposal rejected', 'Draft (abandoned)', 'proposed — rejected by legal 2026-09', 'Pending removal', 'Review: rejected'];
  const files = Object.fromEntries(statuses.map((s, i) => [`${V}/decisions/000${i + 1}-x.md`, st(s).replace('root/0000', `root/000${i + 1}`)]));
  files[`${V}/decisions/0009-ok.md`] = st('Draft').replace('root/0000', 'root/0009');
  const root = shop(files);
  try {
    const r = await run(root, ['accept', 'root/0001', 'root/0002', 'root/0003', 'root/0004', 'root/0005']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    for (const [i, s] of statuses.entries()) assert.equal(read(root, `${V}/decisions/000${i + 1}-x.md`), files[`${V}/decisions/000${i + 1}-x.md`], s);
    assert.match(r.stderr, /root\/0004: status is "Pending removal", not plain proposed; edit it by hand if it should be accepted/);
    const ok = await run(root, ['accept', 'root/0009']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(read(root, `${V}/decisions/0009-ok.md`), /^status: accepted$/m);
  } finally {
    cleanup(root);
  }
});

test('new: a module name in another case joins the existing module; ids stay in one namespace', async () => {
  const root = shop({
    [`${V}/modules/Billing/Billing.md`]: moduleNote('Billing', ['src/billing/**']),
    [`${V}/modules/Billing/decisions/0001-first.md`]: record({ id: 'Billing/0001', title: 'First' }),
  });
  try {
    const r = await run(root, ['new', 'billing', 'Second', '--supersedes', 'billing/0001', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { id: 'Billing/0002', path: `${V}/modules/Billing/decisions/0002-second.md` });
    assert.match(read(root, `${V}/modules/Billing/decisions/0002-second.md`), /^supersedes: \[Billing\/0001\]$/m);
    assert.deepEqual(rec(root, 'Billing/0001').pendingReplacements, ['Billing/0002']);
  } finally {
    cleanup(root);
  }
});

test('new: --governs may not climb out of the repo through ..', async () => {
  const root = shop();
  try {
    const before = snapshot(root);
    const r = await run(root, ['new', 'billing', 'X', '--governs', 'src/../../outside/**']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--governs src\/\.\.\/\.\.\/outside\/\*\* is not a path inside the repo/);
    assert.deepEqual(snapshot(root), before);
    const ok = await run(root, ['new', 'billing', 'Y', '--governs', './src/./billing/../payments', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(read(root, JSON.parse(ok.stdout).path), /^governs: \[src\/payments\]$/m);
  } finally {
    cleanup(root);
  }
});
