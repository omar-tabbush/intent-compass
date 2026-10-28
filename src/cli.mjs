// Command dispatch. Each command lives in src/commands/<name>.mjs and exports run().
// --help and unknown flags are handled here, before a command module is loaded or run,
// so a typo or a request for help never writes anything.

import { parseArgs } from './io.mjs';

export const COMMANDS = {
  init: {
    summary: 'Set up .intent.json and the vault (--import, --hooks, --skill, --rules)',
    usage: 'intent init [--vault DIR] [--code a,b] [--import SRC] [--hooks] [--skill] [--force] [--rules] [--json]',
    flags: ['vault', 'code', 'import', 'hooks', 'skill', 'force', 'rules', 'json'],
  },
  import: {
    summary: 'Copy an Obsidian-style vault into this vault (source is never modified)',
    usage: 'intent import SRC [--dry-run] [--json]',
    flags: ['dry-run', 'json'],
  },
  why: {
    summary: 'List the decisions and module notes that govern a file or folder',
    usage: 'intent why PATH... [--json]',
    flags: ['json'],
  },
  check: {
    summary: 'Intent-debt report with a 0-100 score',
    usage: 'intent check [--json] [--min N]',
    flags: ['json', 'min'],
  },
  capture: {
    summary: 'Propose records for changed code that no decision governs',
    usage: 'intent capture [--since REF] [--dry-run] [--json]',
    flags: ['since', 'dry-run', 'json'],
  },
  touch: {
    summary: 'Mark files as changed in this session',
    usage: 'intent touch PATH... [--verbose]',
    flags: ['verbose'],
  },
  rules: {
    summary: 'Write or refresh the agent rules block in AGENTS.md / CLAUDE.md',
    usage: 'intent rules [--check] [--create] [--json]',
    flags: ['check', 'create', 'json'],
  },
  new: {
    summary: 'Write a new record with an allocated ID',
    usage: 'intent new MODULE "TITLE" [--governs a,b] [--supersedes ID] [--why TEXT] [--provenance human|ai-suggested|inferred-from-code|imported] [--status proposed|accepted] [--context TEXT] [--decision TEXT] [--alternatives TEXT] [--consequences TEXT] [--review YYYY-MM-DD] [--tags a,b] [--json]',
    flags: ['governs', 'supersedes', 'why', 'provenance', 'status', 'context', 'decision', 'alternatives', 'consequences', 'review', 'tags', 'json'],
  },
  accept: {
    summary: 'Confirm proposed records',
    usage: 'intent accept ID... [--json]',
    flags: ['json'],
  },
  index: {
    summary: 'Rebuild index.json and generated regions',
    usage: 'intent index',
    flags: [],
  },
  hook: {
    summary: 'Claude Code hook entry (reads hook JSON on stdin)',
    usage: 'intent hook   (Claude Code runs it with the hook JSON on stdin)',
    flags: null, // anything goes: the hook never fails
  },
};

// "usage: intent <cmd> ..." for a command's own usage errors.
export function usageOf(name) {
  return `usage: ${COMMANDS[name].usage}`;
}

export function usage() {
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  return [
    'intent — keep the why next to the code',
    '',
    'Usage: intent <command> [args]   (intent <command> --help for its flags)',
    '',
    ...Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(w)}  ${v.summary}`),
    '',
    'Docs: README.md, docs/SPEC.md',
  ].join('\n');
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// The known flag a typo most likely meant, or null.
function closest(flag, known) {
  const prefix = known.find((k) => k.startsWith(flag) || flag.startsWith(k));
  if (prefix) return prefix;
  const ranked = known.map((k) => [distance(flag, k), k]).sort((a, b) => a[0] - b[0]);
  return ranked.length && ranked[0][0] <= 2 ? ranked[0][1] : null;
}

export async function main(argv, io) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') { io.out(usage()); return 0; }
  if (name === '--version' || name === '-v') { io.out('0.1.0'); return 0; }
  if (!Object.hasOwn(COMMANDS, name)) { io.err(`intent: unknown command "${name}"`); io.err(usage()); return 2; }
  const cmd = COMMANDS[name];
  const dash = rest.indexOf('--');
  const own = dash === -1 ? rest : rest.slice(0, dash);
  if (cmd.flags && (own.includes('--help') || own.includes('-h'))) {
    io.out(`${usageOf(name)}\n${cmd.summary}`);
    return 0;
  }
  const args = parseArgs(rest);
  if (cmd.flags) {
    for (const flag of Object.keys(args.flags)) {
      if (cmd.flags.includes(flag)) continue;
      const near = closest(flag, cmd.flags);
      io.err(`intent ${name}: unknown flag --${flag}${near ? ` (did you mean --${near}?)` : ''}`);
      io.err(usageOf(name));
      return 2;
    }
    if (args.errors.length) { io.err(`intent ${name}: ${args.errors[0]}`); return 2; }
  }
  const mod = await import(`./commands/${name}.mjs`);
  return (await mod.run(args, io)) ?? 0;
}
