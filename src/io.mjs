// Argument parsing and the io object every command receives.

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && VALUE_FLAGS.has(name)) { flags[name] = next; i++; }
      else flags[name] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

// Flags that take a value. Everything else is boolean.
const VALUE_FLAGS = new Set([
  'vault', 'code', 'import', 'since', 'min', 'governs', 'supersedes', 'why', 'context',
  'decision', 'alternatives', 'consequences', 'provenance', 'status', 'review', 'tags', 'title',
]);

export function list(flag) {
  if (flag === undefined || flag === true || flag === null) return [];
  return String(flag).split(',').map((s) => s.trim()).filter(Boolean);
}

export function makeIO({ cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  const now = env.INTENT_NOW ? new Date(env.INTENT_NOW) : new Date();
  return {
    cwd,
    env,
    now,
    out: (s = '') => stdout.write(s + '\n'),
    err: (s = '') => stderr.write(s + '\n'),
    readStdin: () =>
      new Promise((resolve) => {
        if (!stdin || stdin.isTTY) return resolve('');
        let data = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (c) => { data += c; });
        stdin.on('end', () => resolve(data));
        stdin.on('error', () => resolve(data));
      }),
  };
}

// For tests: run with captured output.
export function captureIO({ cwd, env = {}, stdin = '' }) {
  const outBuf = [];
  const errBuf = [];
  return {
    io: {
      cwd,
      env,
      now: env.INTENT_NOW ? new Date(env.INTENT_NOW) : new Date(),
      out: (s = '') => outBuf.push(s),
      err: (s = '') => errBuf.push(s),
      readStdin: async () => stdin,
    },
    stdout: () => outBuf.join('\n'),
    stderr: () => errBuf.join('\n'),
  };
}
