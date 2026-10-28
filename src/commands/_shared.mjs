// Helpers shared by commands.

export { refresh } from '../index.mjs';

export function notOptedIn(io) {
  io.err('intent: no .intent.json here or in any parent folder. Run `intent init` to opt this repo in.');
  return 1;
}
