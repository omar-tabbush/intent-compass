import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContext } from '../src/config.mjs';
import { applyRules, rulesBlock, rulesStatus } from '../src/rules.mjs';
import { brokenMarkers } from '../src/commands/rules.mjs';
import { makeRepo, run, read, exists, cleanup, tempDir, writeTree, record, moduleNote } from './helpers.mjs';

const block = (root) => rulesBlock(loadContext(root));
const json = (r) => JSON.parse(r.stdout);

// Every file under dir with its bytes, to prove a command left them alone.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, child)).isDirectory()) walk(child);
      else out[child] = readFileSync(join(dir, child), 'utf8');
    }
  };
  walk('');
  return out;
}

test('rules: creates AGENTS.md and skips a missing CLAUDE.md', async () => {
  const root = makeRepo();
  try {
    const r = await run(root, ['rules']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'AGENTS.md: created\nCLAUDE.md: skipped (file does not exist; create it or pass --create)');
    assert.equal(r.stderr, '');
    assert.equal(read(root, 'AGENTS.md'), `# Agent instructions\n\n${block(root)}\n`);
    assert.equal(exists(root, 'CLAUDE.md'), false);
  } finally { cleanup(root); }
});

test('rules --create: also creates CLAUDE.md', async () => {
  const root = makeRepo();
  try {
    const r = await run(root, ['rules', '--create']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'AGENTS.md: created\nCLAUDE.md: created');
    assert.equal(read(root, 'CLAUDE.md'), `# Agent instructions\n\n${block(root)}\n`);
    assert.equal((await run(root, ['rules', '--check'])).code, 0);
  } finally { cleanup(root); }
});

test('rules: adds the block to an existing file without touching its text', async () => {
  const before = '# Harbor Desk agent notes\n\nUse pnpm, never npm.\n- Ports: 4100\n';
  const root = makeRepo({ 'CLAUDE.md': before, 'AGENTS.md': before });
  try {
    const r = await run(root, ['rules']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'AGENTS.md: added\nCLAUDE.md: added');
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const after = read(root, f);
      assert.ok(after.startsWith(before), `${f} keeps its original bytes`);
      assert.equal(after.slice(before.length), `\n${block(root)}\n`);
    }
  } finally { cleanup(root); }
});

test('rules: refreshes an outdated block in the middle of a file, bytes outside the block unchanged', async () => {
  const head = '# Agent notes\n\nIntro written by a person.\n\n';
  const tail = '\n\n## After the block\nKeep this exactly.  \n\n';
  const root = makeRepo({}, { config: { rulesFiles: ['AGENTS.md'] } });
  try {
    const good = block(root);
    const stale = good.replace(/hash=[a-f0-9]+/, 'hash=0000000000');
    writeTree(root, { 'AGENTS.md': head + stale + tail });
    assert.equal(json(await run(root, ['rules', '--check', '--json'])).files[0].state, 'outdated');
    const r = await run(root, ['rules']);
    assert.equal(r.stdout, 'AGENTS.md: updated');
    const after = read(root, 'AGENTS.md');
    assert.equal(after.slice(0, head.length), head);
    assert.equal(after.slice(after.length - tail.length), tail);
    assert.equal(after.slice(head.length, after.length - tail.length), good);
  } finally { cleanup(root); }
});

test('rules: an edit inside the block (hash intact) is outdated and gets refreshed', async () => {
  const root = makeRepo();
  try {
    await run(root, ['rules']);
    const edited = read(root, 'AGENTS.md').replace('Never invent a rationale.', 'Invent a rationale if unsure.');
    writeFileSync(join(root, 'AGENTS.md'), edited);
    const c = await run(root, ['rules', '--check']);
    assert.equal(c.code, 1);
    assert.match(c.stdout, /^AGENTS\.md: outdated/m);
    assert.equal((await run(root, ['rules'])).stdout.split('\n')[0], 'AGENTS.md: updated');
    assert.equal(read(root, 'AGENTS.md'), `# Agent instructions\n\n${block(root)}\n`);
  } finally { cleanup(root); }
});

test('rules: second run is unchanged and writes nothing', async () => {
  const root = makeRepo({ 'CLAUDE.md': '# Notes\n' });
  try {
    await run(root, ['rules']);
    const first = { a: read(root, 'AGENTS.md'), c: read(root, 'CLAUDE.md') };
    const r = await run(root, ['rules']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'AGENTS.md: unchanged\nCLAUDE.md: unchanged');
    assert.deepEqual({ a: read(root, 'AGENTS.md'), c: read(root, 'CLAUDE.md') }, first);
  } finally { cleanup(root); }
});

test('rules --check: states and exit codes', async () => {
  const root = makeRepo();
  try {
    let r = await run(root, ['rules', '--check']);
    assert.equal(r.code, 1, 'AGENTS.md missing fails');
    assert.equal(r.stdout, 'AGENTS.md: no file\nCLAUDE.md: no file (optional)\nRun: intent rules');
    assert.equal(exists(root, 'AGENTS.md'), false, '--check writes nothing');

    await run(root, ['rules']);
    r = await run(root, ['rules', '--check']);
    assert.equal(r.code, 0, 'a missing CLAUDE.md is not a failure');
    assert.equal(r.stdout, 'AGENTS.md: ok\nCLAUDE.md: no file (optional)');

    writeTree(root, { 'CLAUDE.md': '# Claude notes\n' });
    r = await run(root, ['rules', '--check']);
    assert.equal(r.code, 1, 'an existing CLAUDE.md without the block fails');
    assert.match(r.stdout, /^CLAUDE\.md: missing/m);

    r = await run(root, ['rules', '--check', '--json']);
    assert.equal(r.code, 1);
    assert.deepEqual(json(r), {
      ok: false,
      files: [
        { file: 'AGENTS.md', state: 'ok', ok: true, broken: null },
        { file: 'CLAUDE.md', state: 'missing', ok: false, broken: null },
      ],
    });
  } finally { cleanup(root); }
});

test('rules --json: one JSON document with each file action', async () => {
  const root = makeRepo({ 'CLAUDE.md': '# Notes\n' });
  try {
    const r = await run(root, ['rules', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(json(r), {
      files: [
        { file: 'AGENTS.md', action: 'created', reason: null },
        { file: 'CLAUDE.md', action: 'added', reason: null },
      ],
    });
    const again = json(await run(root, ['rules', '--json']));
    assert.deepEqual(again.files.map((f) => f.action), ['unchanged', 'unchanged']);
  } finally { cleanup(root); }
});

test('rules: not opted in exits 1 with the shared message and writes nothing', async () => {
  const dir = tempDir();
  try {
    for (const argv of [['rules'], ['rules', '--check'], ['rules', '--json']]) {
      const r = await run(dir, argv);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, 'intent: no .intent.json here or in any parent folder. Run `intent init` to opt this repo in.');
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally { cleanup(dir); }
});

test('rules: runs from a subfolder, writes at the repo root, block names the configured vault', async () => {
  const root = makeRepo({ 'src/ferries/x.ts': '' }, { config: { vault: 'docs/why', rulesFiles: ['AGENTS.md'] } });
  try {
    const r = await run(join(root, 'src/ferries'), ['rules']);
    assert.equal(r.stdout, 'AGENTS.md: created');
    assert.equal(exists(root, 'src/ferries/AGENTS.md'), false);
    assert.match(read(root, 'AGENTS.md'), /records its intent \(decisions and the why behind them\) in `docs\/why\/`/);
  } finally { cleanup(root); }
});

test('rules: never touches vault files (records stay byte-identical)', async () => {
  const root = makeRepo({
    'intent-vault/modules/ferries/ferries.md': moduleNote('ferries', ['src/ferries/**']),
    'intent-vault/modules/ferries/decisions/0001-boarding.md': record({ id: 'ferries/0001', title: 'Boarding closes ten minutes early', module: 'ferries', governs: ['src/ferries/**'] }),
  });
  try {
    const vault = join(root, 'intent-vault');
    const before = snapshot(vault);
    await run(root, ['rules', '--create']);
    await run(root, ['rules', '--check']);
    assert.deepEqual(snapshot(vault), before);
  } finally { cleanup(root); }
});

test('rules: empty or string rulesFiles config', async () => {
  const empty = makeRepo({}, { config: { rulesFiles: [] } });
  const single = makeRepo({}, { config: { rulesFiles: 'AGENTS.md' } });
  try {
    let r = await run(empty, ['rules']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /No rules files configured/);
    assert.equal(exists(empty, 'AGENTS.md'), false);
    assert.equal((await run(empty, ['rules', '--check'])).code, 0);
    assert.deepEqual(json(await run(empty, ['rules', '--check', '--json'])), { ok: true, files: [] });

    r = await run(single, ['rules']);
    assert.equal(r.stdout, 'AGENTS.md: created');
  } finally { cleanup(empty); cleanup(single); }
});

test('rules: stray positional argument is a usage error', async () => {
  const root = makeRepo();
  try {
    const r = await run(root, ['rules', 'AGENTS.md']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^usage: intent rules/);
    assert.equal(exists(root, 'AGENTS.md'), false);
  } finally { cleanup(root); }
});

test('brokenMarkers: only none, or one start before one end, is safe', () => {
  const s = '<!-- intent-compass:start hash=abc123 -->';
  const e = '<!-- intent-compass:end -->';
  assert.equal(brokenMarkers('# plain file\n'), null);
  assert.equal(brokenMarkers(`a\n${s}\nx\n${e}\nb`), null);
  assert.equal(brokenMarkers(`a\n${s}\nx\n`), '1 start and 0 end markers');
  assert.equal(brokenMarkers(`a\n${e}\nx\n`), '0 start and 1 end marker');
  assert.equal(brokenMarkers(`${e}\n${s}\n`), '1 start and 1 end marker');
  assert.equal(brokenMarkers(`${s}\n${e}\n${s}\n${e}\n`), '2 start and 2 end markers');
});

test('rules: refuses a file with a lost end marker and keeps the user text', async () => {
  const text = '# Notes\n\n<!-- intent-compass:start hash=abc -->\nold rules\n\n## My section\nKeep me.\n';
  const root = makeRepo({ 'AGENTS.md': text, 'CLAUDE.md': '# Claude\n' });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await run(root, ['rules']);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /^AGENTS\.md: skipped \(broken markers: 1 start and 0 end markers; fix them by hand\)$/m);
      assert.match(r.stdout, /^CLAUDE\.md: (added|unchanged)$/m, 'other files are still handled');
      assert.equal(read(root, 'AGENTS.md'), text);
    }
    const c = await run(root, ['rules', '--check', '--json']);
    assert.equal(c.code, 1);
    assert.deepEqual(json(c).files[0], { file: 'AGENTS.md', state: 'missing', ok: false, broken: '1 start and 0 end markers' });
  } finally { cleanup(root); }
});

test('rules: refuses a stray end marker and two blocks; --check fails on them', async () => {
  const stray = '# A\n<!-- intent-compass:end -->\nmiddle\n';
  const root = makeRepo({ 'AGENTS.md': stray }, { config: { rulesFiles: ['AGENTS.md'] } });
  try {
    let r = await run(root, ['rules']);
    assert.equal(r.code, 1);
    assert.equal(read(root, 'AGENTS.md'), stray);

    const twice = `${block(root)}\n\n${block(root)}\n`;
    writeTree(root, { 'AGENTS.md': twice });
    r = await run(root, ['rules', '--check']);
    assert.equal(r.code, 1, 'the first block is current, but the duplicate still fails');
    assert.match(r.stdout, /^AGENTS\.md: ok; broken markers: 2 start and 2 end markers, fix them by hand$/m);
    assert.equal((await run(root, ['rules'])).code, 1);
    assert.equal(read(root, 'AGENTS.md'), twice);
  } finally { cleanup(root); }
});

// The core itself refuses broken markers, so every caller (intent rules, intent init --rules) is safe.
test('core applyRules: a lost end marker never deletes user text, on any run', () => {
  const text = '# A\n\n<!-- intent-compass:start hash=abc -->\nold\n\n## My notes\nKeep me.\n';
  const root = makeRepo({ 'AGENTS.md': text }, { config: { rulesFiles: ['AGENTS.md'] } });
  try {
    const ctx = loadContext(root);
    assert.deepEqual(applyRules(ctx), [{ file: 'AGENTS.md', action: 'skipped', broken: '1 start and 0 end markers' }]);
    applyRules(ctx);
    assert.equal(read(root, 'AGENTS.md'), text);
  } finally { cleanup(root); }
});

test('core applyRules: a stray end marker is refused every time, so the file converges unchanged', () => {
  // Before the fix, each run copied "middle" again and never reached 'unchanged'.
  const text = '# A\n<!-- intent-compass:end -->\nmiddle\n';
  const root = makeRepo({ 'AGENTS.md': text }, { config: { rulesFiles: ['AGENTS.md'] } });
  try {
    const ctx = loadContext(root);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(applyRules(ctx), [{ file: 'AGENTS.md', action: 'skipped', broken: '0 start and 1 end marker' }]);
    }
    assert.equal(read(root, 'AGENTS.md'), text);
  } finally { cleanup(root); }
});

test('core rulesStatus: the end marker is found after the start; broken files are flagged', () => {
  const root = makeRepo({}, { config: { rulesFiles: ['AGENTS.md'] } });
  try {
    const ctx = loadContext(root);
    writeTree(root, { 'AGENTS.md': `# A\n<!-- intent-compass:end -->\n\n${rulesBlock(ctx)}\n` });
    assert.deepEqual(rulesStatus(ctx), [{ file: 'AGENTS.md', state: 'ok', broken: '1 start and 2 end markers' }]);
    writeTree(root, { 'AGENTS.md': `# A\n\n${rulesBlock(ctx)}\n` });
    assert.deepEqual(rulesStatus(ctx), [{ file: 'AGENTS.md', state: 'ok' }]);
  } finally { cleanup(root); }
});

test('core applyRules: appending keeps every byte of the user text, trailing blank lines included', () => {
  for (const text of ['# A\n\n\n', '# A  \n', '# A', '']) {
    const root = makeRepo({ 'AGENTS.md': text }, { config: { rulesFiles: ['AGENTS.md'] } });
    try {
      const ctx = loadContext(root);
      assert.deepEqual(applyRules(ctx), [{ file: 'AGENTS.md', action: 'added' }]);
      const after = read(root, 'AGENTS.md');
      assert.ok(after.startsWith(text), JSON.stringify(text));
      assert.ok(after.endsWith(`${rulesBlock(ctx)}\n`));
      assert.deepEqual(applyRules(ctx), [{ file: 'AGENTS.md', action: 'unchanged' }]);
    } finally { cleanup(root); }
  }
});

test('core rules: a string rulesFiles is one file, not a crash', () => {
  const root = makeRepo({}, { config: { rulesFiles: 'AGENTS.md' } });
  try {
    const ctx = loadContext(root);
    assert.deepEqual(applyRules(ctx), [{ file: 'AGENTS.md', action: 'created' }]);
    assert.deepEqual(rulesStatus(ctx), [{ file: 'AGENTS.md', state: 'ok' }]);
  } finally { cleanup(root); }
});
