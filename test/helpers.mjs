// Test helpers: temp repos with a vault, and in-process command runs.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { captureIO } from '../src/io.mjs';

export const NOW = '2026-10-27T12:00:00Z';

export function tempDir(prefix = 'intent-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

// files: { 'repo/relative/path': 'content' }. Objects are written as JSON.
export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

export function makeRepo(files = {}, { config = {}, git = false } = {}) {
  const root = tempDir();
  writeTree(root, { '.intent.json': { version: 1, vault: 'intent-vault', codeRoots: ['src'], ...config }, ...files });
  if (git) {
    gitRun(root, ['init', '-q']);
    gitRun(root, ['config', 'user.email', 'test@example.com']);
    gitRun(root, ['config', 'user.name', 'Test']);
    gitRun(root, ['config', 'commit.gpgsign', 'false']);
  }
  return root;
}

export function gitRun(root, args, env = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
}

// Commit everything with a fixed date (YYYY-MM-DD).
export function commitAll(root, message, date) {
  gitRun(root, ['add', '-A']);
  const d = `${date}T10:00:00Z`;
  gitRun(root, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
}

export async function run(cwd, argv, { env = {}, stdin = '' } = {}) {
  const cap = captureIO({ cwd, env: { INTENT_NOW: NOW, ...env }, stdin });
  const code = await main(argv, cap.io);
  return { code, stdout: cap.stdout(), stderr: cap.stderr() };
}

export function read(root, rel) {
  return readFileSync(join(root, rel), 'utf8');
}

export function exists(root, rel) {
  return existsSync(join(root, rel));
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

export function record({ id, title, status = 'accepted', date = '2026-09-01', module, governs = [], supersedes = [], review_date, provenance = 'human', why = 'Because the human said so in review.' }) {
  const lines = ['---', `id: ${id}`, `title: ${title}`, `status: ${status}`, `date: ${date}`];
  if (module) lines.push(`module: ${module}`);
  lines.push(`governs: [${governs.join(', ')}]`, `provenance: ${provenance}`);
  if (review_date) lines.push(`review_date: ${review_date}`);
  lines.push(`supersedes: [${supersedes.join(', ')}]`, '---', `# ${title}`, '', '## Context', '', 'Some context.', '', '## Decision', '', title, '', '## Why — the intent', '', why, '');
  return lines.join('\n');
}

export function moduleNote(name, governs = []) {
  return [
    '---', 'type: module', `module: ${name}`, `governs: [${governs.join(', ')}]`, '---', `# ${name}`, '',
    '<!-- intent:generated:decisions:start -->', '<!-- intent:generated:decisions:end -->', '',
  ].join('\n');
}
