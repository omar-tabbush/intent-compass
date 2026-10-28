#!/usr/bin/env node
// Everything is loaded dynamically, so that on the hook path even a module that fails to load
// (a syntax error, a missing export) exits 0 with no output: a hook must never block the agent.

const argv = process.argv.slice(2);
const isHook = argv[0] === 'hook';
if (isHook) {
  const quiet = () => process.exit(0);
  process.on('uncaughtException', quiet);
  process.on('unhandledRejection', quiet);
}

try {
  const { main } = await import('../src/cli.mjs');
  const { makeIO } = await import('../src/io.mjs');
  process.exitCode = (await main(argv, makeIO())) ?? 0;
} catch (e) {
  if (isHook) process.exitCode = 0;
  else {
    process.stderr.write(`intent: ${e && e.message ? e.message : e}\n`);
    process.exitCode = e && Number.isInteger(e.exitCode) ? e.exitCode : 2;
  }
}
