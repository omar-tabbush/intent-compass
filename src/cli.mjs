// Command dispatch. Each command lives in src/commands/<name>.mjs and exports run().

import { parseArgs } from './io.mjs';

export const COMMANDS = {
  init: 'Set up .intent.json and the vault (--import, --hooks, --skill, --rules)',
  import: 'Copy an Obsidian-style vault into this vault (source is never modified)',
  why: 'List the decisions and module notes that govern a file or folder',
  check: 'Intent-debt report with a 0-100 score',
  capture: 'Propose records for changed code that no decision governs',
  touch: 'Mark files as changed in this session',
  rules: 'Write or refresh the agent rules block in AGENTS.md / CLAUDE.md',
  new: 'Write a new record with an allocated ID',
  accept: 'Confirm proposed records',
  index: 'Rebuild index.json and generated regions',
  hook: 'Claude Code hook entry (reads hook JSON on stdin)',
};

export function usage() {
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  return [
    'intent — keep the why next to the code',
    '',
    'Usage: intent <command> [args]',
    '',
    ...Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(w)}  ${v}`),
    '',
    'Docs: README.md, docs/SPEC.md',
  ].join('\n');
}

export async function main(argv, io) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') { io.out(usage()); return 0; }
  if (name === '--version' || name === '-v') { io.out('0.1.0'); return 0; }
  if (!Object.hasOwn(COMMANDS, name)) { io.err(`intent: unknown command "${name}"`); io.err(usage()); return 2; }
  const mod = await import(`./commands/${name}.mjs`);
  return (await mod.run(parseArgs(rest), io)) ?? 0;
}
