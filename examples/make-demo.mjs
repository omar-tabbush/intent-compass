#!/usr/bin/env node
// Make a throwaway git copy of examples/demo with dated history, so `intent check`
// has drift to find. Usage: node examples/make-demo.mjs [dest]

import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'demo');
const dest = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'intent-demo-'));
if (existsSync(join(dest, '.intent.json'))) {
  console.error(`make-demo: ${dest} already has a demo; pick another folder.`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true, filter: (p) => !p.includes(`${'/'}.cache`) });

const git = (args, date) =>
  execFileSync('git', args, {
    cwd: dest,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: date
      ? { ...process.env, GIT_AUTHOR_DATE: `${date}T10:00:00Z`, GIT_COMMITTER_DATE: `${date}T10:00:00Z` }
      : process.env,
  });

git(['init', '-q']);
git(['config', 'user.email', 'demo@example.com']);
git(['config', 'user.name', 'Demo']);
git(['config', 'commit.gpgsign', 'false']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'Guest checkout, orders and payments'], '2026-01-10');

// A later change to pricing, after the decision that governs it was recorded.
const pricing = join(dest, 'src/orders/pricing.js');
writeFileSync(pricing, readFileSync(pricing, 'utf8') + `
export function bulkDiscount(totalCents) {
  return totalCents >= 5000 ? Math.round(totalCents * 0.9) : totalCents;
}
`);
git(['add', '-A']);
git(['commit', '-q', '-m', 'Add bulk discount'], '2026-08-02');

// An uncommitted change in an area with no recorded intent, for `intent capture`.
const email = join(dest, 'src/notifications/email.js');
writeFileSync(email, readFileSync(email, 'utf8') + `
export function pickupReminder(order) {
  return { to: order.guestEmail, subject: 'Pickup in 30 minutes' };
}
`);

console.log(dest);
