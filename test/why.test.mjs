import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, run, exists, cleanup, record, moduleNote, tempDir, writeTree } from './helpers.mjs';

// Every file under a folder, for "nothing was written" checks.
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

// A fictional shop: billing with a superseded and a proposed record, plus a mention-only root record.
function shop() {
  return makeRepo({
    'src/billing/refunds/refund.ts': '',
    'src/billing/invoice.ts': '',
    'src/auth/login.ts': '',
    'src/search/index.ts': '',
    'intent-vault/modules/billing/billing.md': moduleNote('billing', ['src/billing/**']),
    'intent-vault/modules/billing/decisions/0001-refunds-to-store-credit.md': record({ id: 'billing/0001', title: 'Refunds become store credit', module: 'billing', governs: ['src/billing/refunds/**'] }),
    'intent-vault/modules/billing/decisions/0003-refunds-to-original-method.md': record({ id: 'billing/0003', title: 'Refunds go back to the original payment method', module: 'billing', governs: ['src/billing/refunds/**'], supersedes: ['billing/0001'] }),
    'intent-vault/modules/billing/decisions/0004-refunds-batch.md': record({ id: 'billing/0004', title: 'Refunds are batched nightly', status: 'proposed', module: 'billing', governs: ['src/billing/refunds/**'], why: 'TODO — not recorded. Ask the human why; do not guess.' }),
    'intent-vault/decisions/0001-session-length.md': record({ id: 'root/0001', title: 'Sessions last eight hours', why: 'TODO' }).replace('Some context.', 'See `src/auth/login.ts`.'),
  });
}

test('why: governed file lists module, records by status, and the files to read', async () => {
  const root = shop();
  try {
    const r = await run(root, ['why', 'src/billing/refunds/refund.ts']);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], 'src/billing/refunds/refund.ts');
    assert.equal(lines[1], '  module billing  (intent-vault/modules/billing/billing.md)  governs src/billing/**');
    assert.equal(lines[2], '  accepted    billing/0003  Refunds go back to the original payment method');
    assert.equal(lines[3], '              governs src/billing/refunds/** · in module billing');
    const proposed = lines.findIndex((l) => l.startsWith('  proposed    billing/0004'));
    const superseded = lines.findIndex((l) => l.startsWith('  superseded  billing/0001'));
    assert.ok(proposed > 2 && superseded > proposed, 'active first, then proposed, then superseded');
    assert.match(lines[proposed], /\(proposed, not yet confirmed\)/);
    assert.match(lines[proposed], /\(why not recorded\)/);
    assert.match(lines[superseded], /\(superseded by billing\/0003\)/);
    const read = lines.slice(lines.indexOf('Read before editing:') + 1);
    assert.deepEqual(read, [
      '  intent-vault/modules/billing/decisions/0003-refunds-to-original-method.md',
      '  intent-vault/modules/billing/billing.md',
    ], 'only active records and module notes are listed to read');
  } finally {
    cleanup(root);
  }
});

test('why: mention-only records are marked weaker; missing why is flagged', async () => {
  const root = shop();
  try {
    const r = await run(root, ['why', 'src/auth/login.ts']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /accepted {4}root\/0001 {2}Sessions last eight hours \(why not recorded\)/);
    assert.match(r.stdout, /mentioned in this record only \(weaker than governs\): src\/auth\/login\.ts/);
    assert.match(r.stdout, /Read before editing:\n {2}intent-vault\/decisions\/0001-session-length\.md$/);
  } finally {
    cleanup(root);
  }
});

test('why: no recorded intent prints the hint and exits 0', async () => {
  const root = shop();
  try {
    const r = await run(root, ['why', 'src/search/index.ts']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, [
      'No recorded intent for src/search/index.ts.',
      'If you make a load-bearing choice here, record it: intent new <module> "<rule>" --governs src/search/index.ts',
    ].join('\n'));
  } finally {
    cleanup(root);
  }
});

test('why: only inactive records means nothing to read, plus the hint', async () => {
  const root = makeRepo({
    'src/cart/cart.ts': '',
    'intent-vault/decisions/0001-cart-ttl.md': record({ id: 'root/0001', title: 'Carts expire after a day', status: 'proposed', governs: ['src/cart/**'] }),
    'intent-vault/decisions/0002-cart-cache.md': record({ id: 'root/0002', title: 'Carts live in a cache', status: 'deprecated', governs: ['src/cart/**'] }),
  });
  try {
    const r = await run(root, ['why', 'src/cart/cart.ts']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /proposed {4}root\/0001/);
    assert.match(r.stdout, /deprecated {2}root\/0002/);
    assert.doesNotMatch(r.stdout, /Read before editing/);
    assert.match(r.stdout, /No active record governs src\/cart\/cart\.ts\.\nIf you make a load-bearing choice here/);
  } finally {
    cleanup(root);
  }
});

test('why: folders, several paths, and paths relative to the current folder', async () => {
  const root = shop();
  try {
    const r = await run(join(root, 'src/billing'), ['why', '.', 'refunds/refund.ts', '../search']);
    assert.equal(r.code, 0);
    const blocks = r.stdout.split('\n\n');
    assert.equal(blocks.length, 3);
    assert.match(blocks[0], /^src\/billing\/\n {2}module billing/);
    assert.match(blocks[1], /^src\/billing\/refunds\/refund\.ts\n/);
    assert.match(blocks[2], /^No recorded intent for src\/search\/\./);
  } finally {
    cleanup(root);
  }
});

test('why --json: one document with modules, records and the read list', async () => {
  const root = shop();
  try {
    const r = await run(root, ['why', 'src/billing/refunds/refund.ts', 'src/search', '--json']);
    assert.equal(r.code, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.paths.length, 2);
    const [p, none] = doc.paths;
    assert.equal(p.path, 'src/billing/refunds/refund.ts');
    assert.equal(p.isDir, false);
    assert.deepEqual(p.modules, [{ name: 'billing', path: 'intent-vault/modules/billing/billing.md', governs: ['src/billing/**'], reason: 'module billing governs src/billing/**' }]);
    assert.deepEqual(p.records.map((x) => [x.id, x.effectiveStatus]), [['billing/0003', 'accepted'], ['billing/0004', 'proposed'], ['billing/0001', 'superseded']]);
    const old = p.records.find((x) => x.id === 'billing/0001');
    assert.equal(old.status, 'accepted', 'declared status is untouched; superseded is derived');
    assert.deepEqual(old.supersededBy, ['billing/0003']);
    assert.equal(p.records.find((x) => x.id === 'billing/0004').missingWhy, true);
    for (const x of p.records) {
      for (const k of ['id', 'title', 'status', 'effectiveStatus', 'path', 'reasons', 'missingWhy', 'supersededBy']) assert.ok(k in x, k);
    }
    assert.deepEqual(p.read, ['intent-vault/modules/billing/decisions/0003-refunds-to-original-method.md', 'intent-vault/modules/billing/billing.md']);
    assert.deepEqual(none, { path: 'src/search', isDir: true, modules: [], records: [], read: [] });
  } finally {
    cleanup(root);
  }
});

test('why: reads only; writes no file and no index', async () => {
  const root = shop();
  try {
    const before = snapshot(root);
    await run(root, ['why', 'src/billing', 'src/auth/login.ts']);
    await run(root, ['why', 'src', '--json']);
    assert.deepEqual(snapshot(root), before);
    assert.equal(exists(root, 'intent-vault/index.json'), false);
  } finally {
    cleanup(root);
  }
});

test('why: vault outside the repo is read by absolute path', async () => {
  const vault = tempDir('intent-vault-');
  const root = makeRepo({ 'src/billing/a.ts': '' }, { config: { vault } });
  try {
    writeTree(vault, {
      'modules/billing/billing.md': moduleNote('billing', ['src/billing/**']),
      'modules/billing/decisions/0001-x.md': record({ id: 'billing/0001', title: 'Invoices are immutable', governs: ['src/billing/**'] }),
    });
    const r = await run(root, ['why', 'src/billing/a.ts', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout).paths[0].read, [
      join(vault, 'modules/billing/decisions/0001-x.md'),
      join(vault, 'modules/billing/billing.md'),
    ]);
  } finally {
    cleanup(root);
    cleanup(vault);
  }
});

test('why: path outside the repo is an error (exit 1); others still answered', async () => {
  const root = shop();
  try {
    const r = await run(root, ['why', '../elsewhere.ts', 'src/search/index.ts']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.\.\/elsewhere\.ts is outside the repo/);
    assert.match(r.stdout, /No recorded intent for src\/search\/index\.ts\./);
    const j = await run(root, ['why', '/', '--json']);
    assert.equal(j.code, 1);
    assert.deepEqual(JSON.parse(j.stdout), { paths: [] });
  } finally {
    cleanup(root);
  }
});

test('why: usage without a path (exit 2); silent unless opted in (exit 1)', async () => {
  const root = shop();
  const bare = tempDir();
  try {
    const u = await run(root, ['why']);
    assert.equal(u.code, 2);
    assert.match(u.stderr, /^usage: intent why PATH/);
    assert.equal(u.stdout, '');
    const n = await run(bare, ['why', 'a.ts']);
    assert.equal(n.code, 1);
    assert.equal(n.stdout, '');
    assert.equal(n.stderr.split('\n').length, 1);
  } finally {
    cleanup(root);
    cleanup(bare);
  }
});
