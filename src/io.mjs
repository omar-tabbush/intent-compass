// Argument parsing and the io object every command receives.

// positional: every non-flag argument. late: the ones that came after a flag, so a command can
// refuse "--governs a b" instead of joining b into a title. errors: a value flag given twice.
export function parseArgs(argv) {
  const positional = [];
  const late = [];
  const flags = {};
  const errors = [];
  let sawFlag = false;
  const set = (name, v) => {
    const had = flags[name];
    if (had === undefined) flags[name] = v;
    else if (LIST_FLAGS.has(name) && typeof had === 'string' && typeof v === 'string') flags[name] = `${had},${v}`;
    else if (VALUE_FLAGS.has(name) && had !== v) { if (!errors.includes(`--${name} given more than once`)) errors.push(`--${name} given more than once`); }
    else flags[name] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      sawFlag = true;
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const name = a.slice(2, eq);
        const v = a.slice(eq + 1);
        set(name, VALUE_FLAGS.has(name) ? v : !FALSE_WORDS.has(v.trim().toLowerCase()));
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      // A value may start with "--" ("--why '--no-verify is banned'"), unless it looks like a flag itself.
      if (VALUE_FLAGS.has(name) && next !== undefined && !FLAG_LIKE.test(next)) { set(name, next); i++; }
      else set(name, true);
    } else {
      positional.push(a);
      if (sawFlag) late.push(a);
    }
  }
  return { positional, flags, late, errors };
}

// Flags that take a value. Everything else is boolean.
const VALUE_FLAGS = new Set([
  'vault', 'code', 'import', 'since', 'min', 'governs', 'supersedes', 'why', 'context',
  'decision', 'alternatives', 'consequences', 'provenance', 'status', 'review', 'tags',
]);
// Value flags that may repeat: each value is added to the comma list.
const LIST_FLAGS = new Set(['code', 'governs', 'supersedes', 'tags']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);
const FLAG_LIKE = /^--(?:[A-Za-z][\w-]*(?:=.*)?)?$/s;

export function list(flag) {
  if (flag === undefined || flag === true || flag === null) return [];
  return String(flag).split(',').map((s) => s.trim()).filter(Boolean);
}

const STDIN_MAX = 16 * 1024 * 1024;

export function makeIO({ cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  const now = env.INTENT_NOW ? new Date(env.INTENT_NOW) : new Date();
  return {
    cwd,
    env,
    now,
    out: (s = '') => stdout.write(s + '\n'),
    err: (s = '') => stderr.write(s + '\n'),
    // Hook input is small. Past STDIN_MAX the input is dropped (resolves ''), never a crash.
    readStdin: () =>
      new Promise((resolve) => {
        if (!stdin || stdin.isTTY) return resolve('');
        let data = '';
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try {
          stdin.setEncoding('utf8');
          stdin.on('data', (c) => {
            if (done) return;
            try {
              data += c;
              if (data.length > STDIN_MAX) {
                data = '';
                finish('');
                stdin.removeAllListeners('data');
                if (typeof stdin.destroy === 'function') stdin.destroy();
              }
            } catch { finish(''); }
          });
          stdin.on('end', () => finish(data));
          stdin.on('error', () => finish(data));
        } catch { finish(''); }
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
