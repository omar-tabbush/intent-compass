// List code files in the repo, skipping ignored folders and the vault itself.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { matchPath } from './glob.mjs';

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.obsidian', '.trash']);
const LIMIT = 100000;

export function listFiles(ctx, relDir = '') {
  const out = [];
  const ignore = ctx.config.ignore || [];
  const vault = ctx.vaultInRepo && ctx.vaultRel !== '.' ? ctx.vaultRel : null;
  const skip = (rel) =>
    (vault && (rel === vault || rel.startsWith(vault + '/'))) ||
    ignore.some((g) => matchPath(g, rel));

  const walk = (rel) => {
    if (out.length >= LIMIT) return;
    let entries;
    try { entries = readdirSync(join(ctx.root, rel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (skip(child)) continue;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  if (relDir && skip(relDir)) return out;
  walk(relDir.replace(/\/$/, ''));
  return out;
}

// Immediate sub-folders of a repo-relative folder (for code areas).
export function listDirs(ctx, relDir) {
  try {
    return readdirSync(join(ctx.root, relDir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !ALWAYS_SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => (relDir ? `${relDir}/${e.name}` : e.name))
      .filter((d) => !(ctx.config.ignore || []).some((g) => matchPath(g, d)))
      .sort();
  } catch {
    return [];
  }
}
