import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../src/config.mjs';
import { readHookState, readSession } from '../src/session.mjs';
import { TODO_WHY } from '../src/vault.mjs';
import { stopReason } from '../src/commands/hook.mjs';
import { makeRepo, run, read, exists, cleanup, record, moduleNote, tempDir, NOW } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin/intent.mjs');

function governedRepo(extra = {}) {
  return makeRepo({
    'src/billing/refunds/r.ts': 'r',
    'src/payments/p.ts': 'p',
    'intent-vault/modules/billing/billing.md': moduleNote('billing', ['src/billing/**']),
    'intent-vault/modules/billing/decisions/0001-refunds.md': record({ id: 'billing/0001', title: 'Refunds go back to the original method', governs: ['src/billing/refunds/**'] }),
    'intent-vault/modules/billing/decisions/0002-draft.md': record({ id: 'billing/0002', title: 'Draft about currencies', status: 'proposed', governs: ['src/billing/**'] }),
    ...extra,
  });
}

const edit = (root, file, extra = {}) => ({
  session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
  tool_input: { file_path: join(root, file), old_string: 'a', new_string: 'b' }, ...extra,
});
const post = (root, file, extra = {}) => ({ ...edit(root, file), hook_event_name: 'PostToolUse', tool_response: { filePath: join(root, file) }, ...extra });
const stopEvent = (root, extra = {}) => ({ session_id: 's1', cwd: root, hook_event_name: 'Stop', stop_hook_active: false, ...extra });

async function hook(root, input) {
  const r = await run(root, ['hook'], { stdin: typeof input === 'string' ? input : JSON.stringify(input) });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  return r.stdout;
}

function subprocess(cwd, input) {
  return execFileSync('node', [BIN, 'hook'], { cwd, input, encoding: 'utf8', env: { ...process.env, INTENT_NOW: NOW } });
}

test('hook: not opted in is silent and writes nothing', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'a.ts'), '');
    for (const ev of [edit(dir, 'a.ts'), post(dir, 'a.ts'), stopEvent(dir)]) assert.equal(await hook(dir, ev), '');
    assert.deepEqual(readdirSync(dir), ['a.ts']);
  } finally {
    cleanup(dir);
  }
});

test('hook: garbage, empty or non-object stdin is silent, exit 0', async () => {
  const root = governedRepo();
  try {
    for (const s of ['', 'not json', '{"hook_event_name":', 'null', '42', '[]', '"Stop"']) assert.equal(await hook(root, s), '', s);
    assert.equal(await hook(root, { hook_event_name: 'SessionStart', cwd: root }), '');
    assert.equal(await hook(root, { hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Edit' }), '', 'no tool_input');
    assert.equal(await hook(root, { hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Edit', tool_input: { file_path: 7 } }), '');
  } finally {
    cleanup(root);
  }
});

test('hook PreToolUse: governed file gets context once per session, never a permission decision', async () => {
  const root = governedRepo();
  try {
    const out = await hook(root, edit(root, 'src/billing/refunds/r.ts'));
    const doc = JSON.parse(out);
    assert.deepEqual(Object.keys(doc), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(doc.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.equal(doc.hookSpecificOutput.hookEventName, 'PreToolUse');
    const text = doc.hookSpecificOutput.additionalContext;
    assert.ok(text.startsWith('Intent Compass: you just edited src/billing/refunds/r.ts, which is governed by recorded decisions. Read them now; if your edit breaks an accepted one, tell the user and revert or ask before going on:\n'), text);
    assert.match(text, /^- billing\/0001 \(accepted\): Refunds go back to the original method -> intent-vault\/modules\/billing\/decisions\/0001-refunds\.md$/m);
    assert.match(text, /^- module note billing: intent-vault\/modules\/billing\/billing\.md$/m);
    assert.doesNotMatch(text, /billing\/0002/, 'proposed records are not shown');
    assert.doesNotMatch(out, /permissionDecision|"decision"/);

    assert.equal(await hook(root, edit(root, 'src/billing/refunds/r.ts')), '', 'second time in the session: silent');
    assert.notEqual(await hook(root, edit(root, 'src/billing/refunds/r.ts', { session_id: 's2' })), '', 'a new session sees it again');
    assert.notEqual(await hook(root, edit(root, 'src/billing/invoice.ts', { tool_name: 'Write' })), '', 'another file is shown');
    assert.deepEqual(readHookState(loadContext(root), 's1').shown, ['src/billing/refunds/r.ts', 'src/billing/invoice.ts']);
  } finally {
    cleanup(root);
  }
});

test('hook PreToolUse: ungoverned, proposed-only, vault, outside and non-edit tools are silent', async () => {
  const root = governedRepo({
    'intent-vault/decisions/0001-draft.md': record({ id: 'root/0001', title: 'Draft payments rule', status: 'proposed', governs: ['src/payments/**'] }),
  });
  const outside = tempDir();
  try {
    assert.equal(await hook(root, edit(root, 'src/payments/p.ts')), '', 'only a proposed record governs it');
    assert.equal(await hook(root, edit(root, 'src/search/s.ts')), '', 'nothing governs it');
    assert.equal(await hook(root, edit(root, 'intent-vault/modules/billing/decisions/0001-refunds.md')), '', 'vault file');
    assert.equal(await hook(root, { ...edit(root, 'x'), tool_input: { file_path: join(outside, 'x.ts') } }), '', 'outside the repo');
    assert.equal(await hook(root, edit(root, 'src/billing/refunds/r.ts', { tool_name: 'Read' })), '');
    assert.equal(await hook(root, edit(root, 'src/billing/refunds/r.ts', { tool_name: 'Bash' })), '');
    assert.equal(readHookState(loadContext(root), 's1').shown.length, 0);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('hook PreToolUse: superseded records are not listed; relative paths and NotebookEdit work', async () => {
  const root = makeRepo({
    'src/ml/nb.ipynb': '{}',
    'intent-vault/decisions/0001-old.md': record({ id: 'root/0001', title: 'Old notebook rule', governs: ['src/ml/**'] }),
    'intent-vault/decisions/0002-new.md': record({ id: 'root/0002', title: 'New notebook rule', governs: ['src/ml/**'], supersedes: ['root/0001'] }),
  });
  try {
    const out = await hook(root, { session_id: 's1', cwd: join(root, 'src'), hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: 'ml/nb.ipynb' } });
    const text = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(text, /src\/ml\/nb\.ipynb, which is governed/);
    assert.match(text, /root\/0002 \(accepted\)/);
    assert.doesNotMatch(text, /root\/0001/);
  } finally {
    cleanup(root);
  }
});

test('hook PreToolUse: a module note alone is pointed at; symlinked cwd still maps to the repo', async () => {
  const root = makeRepo({ 'src/feed/f.ts': 'f', 'intent-vault/modules/feed/feed.md': moduleNote('feed', ['src/feed/**']) });
  try {
    const out = await hook(root, { ...edit(root, 'src/feed/f.ts'), cwd: realpathSync(root) });
    const text = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(text, /^Intent Compass: you just edited src\/feed\/f\.ts, which is in a module with notes\. Read them now:/);
    assert.match(text, /^- module note feed: intent-vault\/modules\/feed\/feed\.md$/m);
    writeFileSync(join(root, 'intent-vault/.cache/hook-s2.json'), '"corrupt"');
    assert.notEqual(await hook(root, edit(root, 'src/feed/f.ts', { session_id: 's2' })), '', 'corrupt state is treated as empty');
  } finally {
    cleanup(root);
  }
});

test('hook PreToolUse: at most 8 records, then a pointer to intent why', async () => {
  const files = { 'src/core/c.ts': 'c' };
  for (let i = 1; i <= 10; i++) files[`intent-vault/decisions/${String(i).padStart(4, '0')}-r.md`] = record({ id: `root/${String(i).padStart(4, '0')}`, title: `Rule ${i}`, governs: ['src/core/**'] });
  const root = makeRepo(files);
  try {
    const text = JSON.parse(await hook(root, edit(root, 'src/core/c.ts'))).hookSpecificOutput.additionalContext;
    assert.equal((text.match(/^- root\//gm) || []).length, 8);
    assert.match(text, /^\.\.\. run intent why src\/core\/c\.ts for all$/m);
  } finally {
    cleanup(root);
  }
});

test('hook PostToolUse: touches the file, prints nothing', async () => {
  const root = governedRepo();
  try {
    assert.equal(await hook(root, post(root, 'src/payments/p.ts')), '');
    assert.equal(await hook(root, post(root, 'intent-vault/daily/2026-10-27.md', { tool_name: 'Write' })), '', 'vault files are not touched');
    assert.equal(await hook(root, post(root, 'src/payments/p.ts', { tool_name: 'Read' })), '');
    assert.deepEqual(readSession(loadContext(root)).files.map((f) => f.path), ['src/payments/p.ts']);
  } finally {
    cleanup(root);
  }
});

test('hook Stop: drafts proposals and blocks once, never twice; later Stops still capture', async () => {
  const root = governedRepo({ 'src/search/s.ts': 's', 'src/feed/f.ts': 'f' });
  try {
    await hook(root, post(root, 'src/payments/p.ts'));
    const out = await hook(root, stopEvent(root));
    const doc = JSON.parse(out);
    assert.deepEqual(Object.keys(doc), ['decision', 'reason']);
    assert.equal(doc.decision, 'block');
    assert.match(doc.reason, /^Intent Compass drafted 1 proposed decision record\(s\) for uncommitted or recently touched code that has no recorded intent: root\/0001 \(intent-vault\/decisions\/0001-captured-src-payments\.md\)\./);
    assert.match(doc.reason, /may predate this session/);
    assert.match(doc.reason, /frontmatter `title:` line and in the `# ` heading/);
    assert.match(doc.reason, /provenance: ai-suggested/);
    assert.match(doc.reason, /intent accept <id>/);
    assert.match(doc.reason, /do not delete it/);
    assert.ok(doc.reason.length <= 900, `reason is ${doc.reason.length} chars`);
    const rec = read(root, 'intent-vault/decisions/0001-captured-src-payments.md');
    assert.ok(rec.includes(TODO_WHY), 'Why stays TODO');
    assert.match(rec, /^status: proposed$/m);
    assert.equal(readHookState(loadContext(root), 's1').blocked, true);
    assert.deepEqual(readSession(loadContext(root)).files, [], 'session cleared by capture');

    await hook(root, post(root, 'src/search/s.ts'));
    assert.equal(await hook(root, stopEvent(root)), '', 'already blocked this session');
    assert.ok(exists(root, 'intent-vault/decisions/0002-captured-src-search.md'), 'captured in its own session, without a second block');
    assert.deepEqual(readSession(loadContext(root)).files, []);
    await hook(root, post(root, 'src/feed/f.ts', { session_id: 's2' }));
    assert.notEqual(await hook(root, stopEvent(root, { session_id: 's2' })), '', 'a new session may block once');
  } finally {
    cleanup(root);
  }
});

test('hook Stop: stop_hook_active is silent and captures nothing', async () => {
  const root = governedRepo();
  try {
    await hook(root, post(root, 'src/payments/p.ts'));
    assert.equal(await hook(root, stopEvent(root, { stop_hook_active: true })), '');
    assert.equal(exists(root, 'intent-vault/decisions'), false);
    assert.equal(readSession(loadContext(root)).files.length, 1);
  } finally {
    cleanup(root);
  }
});

test('hook Stop: nothing uncovered is silent and does not mark the session blocked', async () => {
  const root = governedRepo();
  try {
    assert.equal(await hook(root, stopEvent(root)), '', 'nothing changed');
    await hook(root, post(root, 'src/billing/refunds/r.ts'));
    assert.equal(await hook(root, stopEvent(root)), '', 'only governed code changed');
    assert.equal(readHookState(loadContext(root), 's1').blocked, false);
    assert.match(read(root, 'intent-vault/daily/2026-10-27.md'), /billing\/0001/);
  } finally {
    cleanup(root);
  }
});

test('hook Stop: a failed capture is silent and leaves the session unblocked', async () => {
  const root = governedRepo({ 'intent-vault/decisions': 'a file where a folder should be' });
  try {
    await hook(root, post(root, 'src/payments/p.ts'));
    assert.equal(await hook(root, stopEvent(root)), '');
    assert.equal(readHookState(loadContext(root), 's1').blocked, false);
    rmSync(join(root, 'intent-vault/decisions'));
    assert.match(await hook(root, stopEvent(root)), /"decision":"block"/, 'blocks once capture can succeed');
  } finally {
    cleanup(root);
  }
});

test('hook: real subprocess prints a single JSON document or nothing', () => {
  const root = governedRepo();
  const dir = tempDir();
  try {
    const pre = subprocess(root, JSON.stringify(edit(root, 'src/billing/refunds/r.ts')));
    assert.equal(pre.trim().split('\n').length, 1);
    assert.equal(JSON.parse(pre).hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(subprocess(root, JSON.stringify(edit(root, 'src/billing/refunds/r.ts'))), '');
    assert.equal(subprocess(root, JSON.stringify(post(root, 'src/payments/p.ts'))), '');
    const stop = subprocess(root, JSON.stringify(stopEvent(root)));
    assert.equal(stop.trim().split('\n').length, 1);
    assert.equal(JSON.parse(stop).decision, 'block');
    assert.equal(subprocess(root, JSON.stringify(stopEvent(root))), '');
    assert.equal(subprocess(root, 'garbage {'), '');
    assert.equal(subprocess(dir, JSON.stringify(edit(dir, 'a.ts'))), '', 'not opted in');
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('hook: stop reason stays under 900 chars with many proposals', () => {
  const paths = Array.from({ length: 40 }, (_, i) => ({ id: `payments-and-refunds/${String(i + 1).padStart(4, '0')}`, path: `intent-vault/modules/payments-and-refunds/decisions/${String(i + 1).padStart(4, '0')}-captured-src-area-${i}.md` }));
  const reason = stopReason(paths, 'intent-vault/daily/2026-10-27.md');
  assert.ok(reason.length <= 900, `${reason.length}`);
  assert.match(reason, /drafted 40 proposed/);
  assert.match(reason, /and \d+ more \(all listed in intent-vault\/daily\/2026-10-27\.md\)/);
  assert.match(reason, /intent accept <id>/);
});

test('hook: a command module that fails to load still exits 0 with no output, anywhere', async () => {
  const { cpSync, readFileSync: rf } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const copy = tempDir();
  const dir = tempDir();
  try {
    cpSync(join(ROOT, 'bin'), join(copy, 'bin'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(copy, 'src'), { recursive: true });
    const cap = join(copy, 'src/capture.mjs');
    writeFileSync(cap, rf(cap, 'utf8').replace('export function inVault', 'function inVault'));
    const go = (input) => spawnSync('node', [join(copy, 'bin/intent.mjs'), 'hook'], { cwd: dir, input, encoding: 'utf8' });
    for (const input of ['{}', JSON.stringify(edit(dir, 'a.ts')), JSON.stringify(stopEvent(dir))]) {
      const r = go(input);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    }
    const glob = join(copy, 'src/glob.mjs');
    writeFileSync(glob, rf(glob, 'utf8') + '\nexport const broken = ;\n');
    const r = go('{}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
    const other = spawnSync('node', [join(copy, 'bin/intent.mjs'), 'why', 'a.ts'], { cwd: dir, encoding: 'utf8' });
    assert.equal(other.status, 2, 'other commands still report the load error');
    assert.match(other.stderr, /^intent: /);
  } finally {
    cleanup(copy);
    cleanup(dir);
  }
});

test('hook PreToolUse: a subagent gets the context too, once per agent', async () => {
  const root = governedRepo();
  try {
    assert.notEqual(await hook(root, edit(root, 'src/billing/refunds/r.ts')), '');
    const sub = { agent_id: 'a-123', agent_type: 'general-purpose' };
    assert.notEqual(await hook(root, edit(root, 'src/billing/refunds/r.ts', sub)), '', 'a subagent has its own context window');
    assert.equal(await hook(root, edit(root, 'src/billing/refunds/r.ts', sub)), '');
    const long = { agent_id: 'b'.repeat(150) };
    const other = { agent_id: `${'b'.repeat(150)}x` };
    assert.notEqual(await hook(root, edit(root, 'src/billing/refunds/r.ts', long)), '');
    assert.notEqual(await hook(root, edit(root, 'src/billing/refunds/r.ts', other)), '', 'long ids do not collide');
  } finally {
    cleanup(root);
  }
});

test('hook Stop: repeated Stops add one daily section, not one per turn', async () => {
  const root = governedRepo();
  try {
    await hook(root, post(root, 'src/billing/refunds/r.ts'));
    for (let i = 0; i < 3; i++) {
      await hook(root, stopEvent(root));
      await hook(root, post(root, 'src/billing/refunds/r.ts'));
    }
    const daily = read(root, 'intent-vault/daily/2026-10-27.md');
    assert.equal(daily.split('## Captured by intent').length - 1, 1, daily);
  } finally {
    cleanup(root);
  }
});

test('hook PreToolUse: a mention of a whole code root is not presented as governance', async () => {
  const root = makeRepo({
    'src/search/rank.js': '',
    'src/payments/refund.js': '',
    'intent-vault/decisions/0001-layout.md': record({ id: 'root/0001', title: 'Code lives in one tree' }).replace('Some context.', 'All code is under `src/`.'),
    'intent-vault/decisions/0002-rank.md': record({ id: 'root/0002', title: 'Ranking is stable' }).replace('Some context.', 'See `src/search/rank.js`.'),
  });
  try {
    assert.equal(await hook(root, edit(root, 'src/payments/refund.js')), '');
    const text = JSON.parse(await hook(root, edit(root, 'src/search/rank.js'))).hookSpecificOutput.additionalContext;
    assert.match(text, /root\/0002/);
    assert.doesNotMatch(text, /root\/0001/);
    const why = JSON.parse((await run(root, ['why', 'src/payments/refund.js', '--json'])).stdout).paths[0];
    assert.deepEqual(why.records.map((r) => r.id), ['root/0001'], 'still listed by intent why');
    assert.deepEqual(why.read, [], 'but not as a file to read before editing');
  } finally {
    cleanup(root);
  }
});

test('hook: a huge stdin is dropped quietly instead of crashing', async () => {
  const { EventEmitter } = await import('node:events');
  const { makeIO } = await import('../src/io.mjs');
  const stdin = new EventEmitter();
  stdin.setEncoding = () => {};
  stdin.destroy = () => {};
  const io = makeIO({ stdin, env: {} });
  const p = io.readStdin();
  const chunk = 'a'.repeat(1024 * 1024);
  for (let i = 0; i < 20; i++) stdin.emit('data', chunk);
  stdin.emit('end');
  assert.equal(await p, '');
});

test('hook PostToolUse: parallel touches are all kept', async () => {
  const { spawn } = await import('node:child_process');
  const files = {};
  for (let i = 0; i < 12; i++) files[`src/f${i}/x.ts`] = 'x';
  const root = governedRepo(files);
  try {
    const one = (i) => new Promise((resolve) => {
      const child = spawn('node', [BIN, 'hook'], { cwd: root, env: { ...process.env, INTENT_NOW: NOW } });
      child.on('close', resolve);
      child.stdin.end(JSON.stringify(post(root, `src/f${i}/x.ts`)));
    });
    await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
    assert.equal(readSession(loadContext(root)).files.length, 12);
  } finally {
    cleanup(root);
  }
});
