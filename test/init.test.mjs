import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '../src/fm.mjs';
import { BIN, SKILL_DIR, hookCommand, installSkill, mergeHooks } from '../src/commands/init.mjs';
import { run, read, exists, cleanup, tempDir, writeTree } from './helpers.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/obsidian-vault', import.meta.url));
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

function walkAll(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkAll(dir, child));
    else out.push(child);
  }
  return out.sort();
}

// Content hash of every file, dotfiles included; with mtime when asked.
function snapshot(dir, { mtime = false } = {}) {
  const map = {};
  for (const rel of walkAll(dir)) {
    const file = join(dir, rel);
    const hash = createHash('sha1').update(readFileSync(file)).digest('hex');
    map[rel] = mtime ? `${hash} ${statSync(file).mtimeMs}` : hash;
  }
  return map;
}

const config = (root) => JSON.parse(read(root, '.intent.json'));

test('init: writes .intent.json from the defaults, without an ignore list, and detects code roots', async () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, 'lib'));
    mkdirSync(join(root, 'app'));
    writeTree(root, { 'server.txt': 'not a folder' });
    const res = await run(root, ['init']);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(config(root), {
      version: 1, vault: 'intent-vault', codeRoots: ['app', 'lib'], areaDepth: 1,
      reviewMonths: 6, proposedMaxDays: 14, rulesFiles: ['AGENTS.md', 'CLAUDE.md'],
    });
    assert.match(res.stdout, /created {2}\.intent\.json/);
    assert.match(res.stdout, /Next steps:\n {2}intent rules .*\n {2}intent check /);
  } finally {
    cleanup(root);
  }
});

test('init: codeRoots falls back to src; --vault and --code are stored as given', async () => {
  const a = tempDir();
  const b = tempDir();
  try {
    assert.equal((await run(a, ['init'])).code, 0);
    assert.deepEqual(config(a).codeRoots, ['src']);
    const res = await run(b, ['init', '--vault', 'docs/why', '--code', 'services,web/']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(config(b).vault, 'docs/why');
    assert.deepEqual(config(b).codeRoots, ['services', 'web']);
    assert.ok(exists(b, 'docs/why/intent-vault.md'));
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test('init: creates the vault skeleton with a hub, empty-folder placeholders, .gitignore and index', async () => {
  const root = tempDir();
  try {
    const res = await run(root, ['init']);
    assert.equal(res.code, 0, res.stderr);
    const hub = read(root, 'intent-vault/intent-vault.md');
    assert.equal(splitFrontmatter(hub).data.type, 'hub');
    assert.match(hub, /## What this is\n\n.*why/);
    assert.match(hub, /append-only/);
    assert.match(hub, /Never invent a rationale/);
    assert.match(hub, /<!-- intent:generated:hub:start -->\n## Status\n\n0 records[\s\S]*<!-- intent:generated:hub:end -->/);
    for (const d of ['decisions', 'modules', 'daily']) {
      assert.deepEqual(readdirSync(join(root, 'intent-vault', d)), ['.gitkeep'], d);
      assert.equal(read(root, `intent-vault/${d}/.gitkeep`), '');
    }
    assert.equal(read(root, 'intent-vault/.gitignore'), '.cache/\n');
    assert.deepEqual(JSON.parse(read(root, 'intent-vault/index.json')).records, []);
  } finally {
    cleanup(root);
  }
});

test('init: running twice changes nothing the second time', async () => {
  const root = tempDir();
  try {
    writeTree(root, { '.gitignore': 'node_modules/\n', 'src/a.ts': '', 'CLAUDE.md': '# Notes\n' });
    const args = ['init', '--hooks', '--rules', '--import', FIXTURE];
    const first = await run(root, args);
    assert.equal(first.code, 0, first.stderr);
    const before = snapshot(root);
    const times = snapshot(root, { mtime: true });
    const second = await run(root, args);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(snapshot(root), before);
    const after = snapshot(root, { mtime: true });
    for (const [rel, v] of Object.entries(times)) if (rel !== 'intent-vault/index.json') assert.equal(after[rel], v, `${rel} rewritten`);
    assert.match(second.stdout, /Nothing changed/);
    assert.doesNotMatch(second.stdout, /\bcreated\b|\bupdated\b/);
    const json = JSON.parse((await run(root, [...args, '--json'])).stdout);
    assert.equal(json.changed, false);
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('init: an existing .intent.json is never overwritten', async () => {
  const root = tempDir();
  try {
    const original = '{\n  "version": 1,\n  "vault": "notes",\n  "codeRoots": ["lib"],\n  "ignore": ["tmp/**"]\n}\n';
    writeTree(root, { '.intent.json': original });
    const res = await run(root, ['init', '--vault', 'elsewhere', '--code', 'x']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(read(root, '.intent.json'), original);
    assert.ok(exists(root, 'notes/intent-vault.md'));
    assert.ok(!exists(root, 'elsewhere'));
    assert.match(res.stdout, /present {2}\.intent\.json/);
    assert.match(res.stdout, /--vault elsewhere was not applied/);
    assert.match(res.stdout, /--code x was not applied/);
  } finally {
    cleanup(root);
  }
});

test('init: root is the current folder, not a parent that already opted in', async () => {
  const parent = tempDir();
  try {
    writeTree(parent, { '.intent.json': { version: 1, vault: 'pv' }, 'child/README.md': '# child\n' });
    const before = snapshot(parent);
    const res = await run(join(parent, 'child'), ['init']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(exists(parent, 'child/.intent.json'));
    assert.ok(exists(parent, 'child/intent-vault/intent-vault.md'));
    assert.ok(!exists(parent, 'pv'));
    assert.equal(snapshot(parent)['.intent.json'], before['.intent.json']);
  } finally {
    cleanup(parent);
  }
});

test('init: an existing Obsidian vault as the vault: only missing pieces are added, notes untouched', async () => {
  const root = tempDir();
  const vault = tempDir();
  try {
    writeTree(vault, {
      'Atlas.md': '# Atlas\n\nSee [[decisions/0001-queue-per-tenant]].\n',
      'decisions/0001-queue-per-tenant.md': '---\nstatus: accepted\n---\n# One queue per tenant\n\n## Why — the intent\n\nNoisy tenants starved the rest.\n',
      'modules/queue/queue.md': '---\ngoverns: [src/queue/**]\n---\n# queue\n',
      '.obsidian/app.json': '{}',
      '.gitignore': '.trash/',
    });
    const before = snapshot(vault);
    const res = await run(root, ['init', '--vault', vault]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(config(root).vault, vault);
    const after = snapshot(vault);
    for (const [rel, hash] of Object.entries(before)) {
      if (rel !== '.gitignore') assert.equal(after[rel], hash, `${rel} untouched`);
    }
    assert.equal(readFileSync(join(vault, '.gitignore'), 'utf8'), '.trash/\n.cache/\n', 'only .cache/ appended');
    const added = Object.keys(after).filter((k) => !(k in before)).sort();
    assert.deepEqual(added, ['daily/.gitkeep', 'index.json', 'intent-vault.md']);
    const index = JSON.parse(readFileSync(join(vault, 'index.json'), 'utf8'));
    assert.deepEqual(index.records.map((r) => r.id), ['root/0001']);
    assert.match(res.stdout, new RegExp(`present {2}${vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/decisions/`));
  } finally {
    cleanup(root);
    cleanup(vault);
  }
});

test('init --hooks: merges into existing settings, keeps every key, adds no duplicates, gitignores the file', async () => {
  const root = tempDir();
  try {
    const existing = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      model: 'some-model',
    };
    writeTree(root, { '.claude/settings.local.json': existing, '.gitignore': 'node_modules/' });
    const res = await run(root, ['init', '--hooks']);
    assert.equal(res.code, 0, res.stderr);
    const s = JSON.parse(read(root, '.claude/settings.local.json'));
    const entry = { type: 'command', command: `node "${BIN}" hook`, timeout: 10 };
    assert.deepEqual(s.permissions, existing.permissions);
    assert.equal(s.model, 'some-model');
    assert.deepEqual(s.hooks.SessionStart, existing.hooks.SessionStart);
    assert.deepEqual(s.hooks.PreToolUse, [existing.hooks.PreToolUse[0], { matcher: MATCHER, hooks: [entry] }]);
    assert.deepEqual(s.hooks.PostToolUse, [{ matcher: MATCHER, hooks: [entry] }]);
    assert.deepEqual(s.hooks.Stop, [{ hooks: [entry] }]);
    assert.equal(hookCommand(), entry.command);
    assert.ok(existsSync(BIN), 'the hook command points at this repo\'s bin');
    assert.equal(read(root, '.gitignore'), 'node_modules/\n.claude/settings.local.json\n');

    const again = await run(root, ['init', '--hooks']);
    assert.equal(again.code, 0);
    assert.deepEqual(JSON.parse(read(root, '.claude/settings.local.json')), s);
    assert.equal(read(root, '.gitignore'), 'node_modules/\n.claude/settings.local.json\n');
    assert.deepEqual(mergeHooks(root), { action: 'present', added: [] });
  } finally {
    cleanup(root);
  }
});

test('init --hooks: creates the settings file; leaves .gitignore alone when there is none; refuses bad JSON', async () => {
  const root = tempDir();
  const bad = tempDir();
  try {
    const res = await run(root, ['init', '--hooks']);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(Object.keys(JSON.parse(read(root, '.claude/settings.local.json')).hooks), ['PreToolUse', 'PostToolUse', 'Stop']);
    assert.ok(!exists(root, '.gitignore'));

    writeTree(bad, { '.claude/settings.local.json': '{ "hooks": ' });
    const r = await run(bad, ['init', '--hooks']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(read(bad, '.claude/settings.local.json'), '{ "hooks": ');
    assert.ok(!exists(bad, '.intent.json'), 'nothing written when a check fails');
  } finally {
    cleanup(root);
    cleanup(bad);
  }
});

test('init --skill: copies the skill folder and never overwrites without --force', async () => {
  const from = tempDir();
  const root = tempDir();
  try {
    writeTree(from, { 'SKILL.md': '# skill v1\n', 'refs/commands.md': 'cmds\n' });
    const dest = join(root, '.claude/skills/intent-compass');
    assert.deepEqual(installSkill(root, { from }).map((s) => s.action), ['created', 'created']);
    assert.equal(readFileSync(join(dest, 'refs/commands.md'), 'utf8'), 'cmds\n');
    assert.deepEqual(installSkill(root, { from }).map((s) => s.action), ['present', 'present']);
    writeTree(root, { '.claude/skills/intent-compass/SKILL.md': '# my edits\n' });
    assert.deepEqual(installSkill(root, { from }).map((s) => s.action), ['kept', 'present']);
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), '# my edits\n');
    assert.deepEqual(installSkill(root, { from, force: true }).map((s) => s.action), ['replaced', 'present']);
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), '# skill v1\n');
    assert.throws(() => installSkill(root, { from: join(from, 'missing') }), /skill files not found/);
  } finally {
    cleanup(from);
    cleanup(root);
  }
});

test('init --skill: uses this repo\'s skill folder, or exits 1 when it is missing', async () => {
  const root = tempDir();
  try {
    const shipped = existsSync(SKILL_DIR) ? walkAll(SKILL_DIR) : [];
    const res = await run(root, ['init', '--skill']);
    if (shipped.length) {
      assert.equal(res.code, 0, res.stderr);
      for (const rel of shipped) {
        assert.equal(read(root, `.claude/skills/intent-compass/${rel}`), readFileSync(join(SKILL_DIR, rel), 'utf8'));
      }
    } else {
      assert.equal(res.code, 1);
      assert.match(res.stderr, /skill files not found/);
      assert.ok(!exists(root, '.intent.json'));
    }
  } finally {
    cleanup(root);
  }
});

test('init --rules: writes the rules block and reports each file', async () => {
  const root = tempDir();
  try {
    const res = await run(root, ['init', '--rules']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(read(root, 'AGENTS.md'), /<!-- intent-compass:start hash=[a-f0-9]+ -->/);
    assert.match(res.stdout, /created {2}AGENTS\.md/);
    assert.match(res.stdout, /skipped {2}CLAUDE\.md/);
    assert.ok(!exists(root, 'CLAUDE.md'));
    assert.doesNotMatch(res.stdout, /intent rules {3}write/, 'no rules hint once done');
  } finally {
    cleanup(root);
  }
});

test('init --import: imports the vault, leaves the source untouched, places no placeholder in filled folders', async () => {
  const root = tempDir();
  try {
    const before = snapshot(FIXTURE, { mtime: true });
    const res = await run(root, ['init', '--import', FIXTURE]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(snapshot(FIXTURE, { mtime: true }), before);
    const index = JSON.parse(read(root, 'intent-vault/index.json'));
    assert.equal(index.records.length, 19);
    assert.ok(index.problems.some((p) => p.kind === 'duplicate-id' && p.message.includes('root/0019')));
    assert.ok(!exists(root, 'intent-vault/decisions/.gitkeep'));
    assert.ok(!exists(root, 'intent-vault/modules/.gitkeep'));
    assert.ok(exists(root, 'intent-vault/daily/.gitkeep'));
    assert.match(res.stdout, /Imported 19 records and 3 module notes/);
    assert.match(res.stdout, /Add governs: \[paths\] to these module notes so intent why can find them\./);
  } finally {
    cleanup(root);
  }
});

test('init --import: refuses an overlapping source before writing anything', async () => {
  const root = tempDir();
  try {
    writeTree(root, { 'old/decisions/0001-a.md': '# a\n- Status: accepted\n' });
    const before = snapshot(root, { mtime: true });
    const res = await run(root, ['init', '--vault', 'old/vault', '--import', 'old']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /inside the source/);
    assert.deepEqual(snapshot(root, { mtime: true }), before);
    assert.ok(!exists(root, '.intent.json'));
    const missing = await run(root, ['init', '--import', 'nope']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /source not found/);
  } finally {
    cleanup(root);
  }
});

test('init: flags that need a value; --json prints one JSON document', async () => {
  const root = tempDir();
  try {
    const r = await run(root, ['init', '--vault']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--vault needs a value/);
    assert.ok(!exists(root, '.intent.json'));
    const res = await run(root, ['init', '--json']);
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.root, root);
    assert.equal(out.vault, 'intent-vault');
    assert.equal(out.changed, true);
    assert.ok(out.steps.some((s) => s.path === '.intent.json' && s.action === 'created'));
    assert.equal(out.import, null);
    assert.deepEqual(out.index, { records: 0, modules: 0, problems: 0 });
  } finally {
    cleanup(root);
  }
});

test('init: says how to put intent on PATH only when it is missing', async () => {
  const root = tempDir();
  const bin = tempDir();
  try {
    let res = await run(root, ['init'], { env: { PATH: '' } });
    assert.match(res.stdout, /^ {2}npm install -g ".+" {3}intent is not on PATH; agents are told to run it$/m);
    writeTree(bin, { intent: '#!/bin/sh\n' });
    res = await run(root, ['init'], { env: { PATH: bin } });
    assert.doesNotMatch(res.stdout, /not on PATH/);
  } finally {
    cleanup(root);
    cleanup(bin);
  }
});

test('init: refuses a vault that is the repo root and writes nothing', async () => {
  const root = tempDir();
  try {
    const res = await run(root, ['init', '--vault', '.']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /the vault cannot be the repo root itself/);
    assert.equal(exists(root, '.intent.json'), false);
  } finally {
    cleanup(root);
  }
});
