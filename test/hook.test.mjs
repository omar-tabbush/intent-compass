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
    assert.ok(text.startsWith('Intent Compass: src/billing/refunds/r.ts is governed by recorded decisions. Read them before editing and do not break them without asking the user:\n'));
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
    assert.match(text, /src\/ml\/nb\.ipynb is governed/);
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
    assert.match(text, /^Intent Compass: src\/feed\/f\.ts is in a module with notes\./);
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

test('hook Stop: drafts proposals and blocks once, never twice', async () => {
  const root = governedRepo({ 'src/search/s.ts': 's' });
  try {
    await hook(root, post(root, 'src/payments/p.ts'));
    const out = await hook(root, stopEvent(root));
    const doc = JSON.parse(out);
    assert.deepEqual(Object.keys(doc), ['decision', 'reason']);
    assert.equal(doc.decision, 'block');
    assert.match(doc.reason, /^Intent Compass drafted 1 proposed decision record\(s\) for code changed in this session that has no recorded intent: intent-vault\/decisions\/0001-captured-src-payments\.md\./);
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
    assert.equal(exists(root, 'intent-vault/decisions/0002-captured-src-search.md'), false, 'no capture after the block');
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
  const paths = Array.from({ length: 40 }, (_, i) => `intent-vault/modules/payments-and-refunds/decisions/${String(i + 1).padStart(4, '0')}-captured-src-area-${i}.md`);
  const reason = stopReason(paths, 'intent-vault/daily/2026-10-27.md');
  assert.ok(reason.length <= 900, `${reason.length}`);
  assert.match(reason, /drafted 40 proposed/);
  assert.match(reason, /and \d+ more \(all listed in intent-vault\/daily\/2026-10-27\.md\)/);
  assert.match(reason, /intent accept <id>/);
});
