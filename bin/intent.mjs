#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { makeIO } from '../src/io.mjs';

const io = makeIO();
main(process.argv.slice(2), io).then(
  (code) => { process.exitCode = code; },
  (e) => { io.err(`intent: ${e && e.message ? e.message : e}`); process.exitCode = 2; },
);
