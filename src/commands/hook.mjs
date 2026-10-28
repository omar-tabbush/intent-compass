// intent hook: Claude Code hook entry. Never throws, never approves or denies a tool
// call, and prints nothing unless the repo opted in and there is something to say.

import { loadContext, vaultPath } from '../config.mjs';
import { ACTIVE, governing, loadIndex, shallowMention } from '../index.mjs';
import { readHookState, touch, writeHookState } from '../session.mjs';
import { capture, inVault, repoPath } from '../capture.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_RECORDS = 8;
const MAX_REASON = 900;

export async function run(_args, io) {
  try {
    const input = JSON.parse(await io.readStdin());
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 0;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : io.cwd;
    const ctx = loadContext(cwd);
    if (!ctx) return 0;
    const out = handle(ctx, cwd, input, io);
    if (out) io.out(JSON.stringify(out));
  } catch {
    // Silent by design: a hook error must never get in the agent's or the user's way.
  }
  return 0;
}

function handle(ctx, cwd, input, io) {
  switch (input.hook_event_name) {
    case 'PreToolUse': return preToolUse(ctx, cwd, input);
    case 'PostToolUse': return postToolUse(ctx, cwd, input, io);
    case 'Stop': return stop(ctx, input, io);
    default: return null;
  }
}

function editedFile(ctx, cwd, input) {
  if (!EDIT_TOOLS.has(input.tool_name)) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const p = [ti.file_path, ti.notebook_path].find((x) => typeof x === 'string' && x);
  if (!p) return null;
  const rel = repoPath(ctx, p, cwd);
  return rel && !inVault(ctx, rel) ? rel : null;
}

function hookState(ctx, sessionId) {
  const raw = readHookState(ctx, sessionId);
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { ...s, shown: Array.isArray(s.shown) ? s.shown : [], blocked: s.blocked === true };
}

// A subagent has its own context window, so it gets its own "already shown" list.
function shownKey(input) {
  return typeof input.agent_id === 'string' && input.agent_id ? `${input.session_id}--${input.agent_id}` : input.session_id;
}

// PreToolUse context reaches the agent next to the tool result, after the edit ran: the wording says so.
function preToolUse(ctx, cwd, input) {
  const rel = editedFile(ctx, cwd, input);
  if (!rel) return null;
  const key = shownKey(input);
  const state = hookState(ctx, key);
  if (state.shown.includes(rel)) return null;
  const g = governing(loadIndex(ctx), ctx, rel);
  const records = g.items
    .filter((it) => !shallowMention(ctx, it.reasons))
    .map((it) => it.record)
    .filter((r) => ACTIVE.has(r.effectiveStatus));
  if (!records.length && !g.modules.length) return null;

  const lines = [records.length
    ? `Intent Compass: you just edited ${rel}, which is governed by recorded decisions. Read them now; if your edit breaks an accepted one, tell the user and revert or ask before going on:`
    : `Intent Compass: you just edited ${rel}, which is in a module with notes. Read them now:`];
  for (const r of records.slice(0, MAX_RECORDS)) lines.push(`- ${r.id} (${r.effectiveStatus}): ${r.title} -> ${vaultPath(ctx, r.path)}`);
  if (records.length > MAX_RECORDS) lines.push(`... run intent why ${rel} for all`);
  for (const { module } of g.modules) lines.push(`- module note ${module.name}: ${vaultPath(ctx, module.path)}`);

  // State first: if it cannot be saved, say nothing rather than repeat on every edit.
  state.shown.push(rel);
  writeHookState(ctx, key, state);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } };
}

function postToolUse(ctx, cwd, input, io) {
  const rel = editedFile(ctx, cwd, input);
  if (rel) touch(ctx, [rel], io.now);
  return null;
}

// Capture runs on every Stop, so changes made after the one block are still drafted in their own
// session (and its daily note); only the block itself happens at most once per session.
function stop(ctx, input, io) {
  if (input.stop_hook_active === true) return null;
  const state = hookState(ctx, input.session_id);
  const res = capture(ctx, { now: io.now });
  if (!res.proposals.length || state.blocked) return null;
  // Written only after capture succeeded, so a failed capture can block on a later Stop.
  writeHookState(ctx, input.session_id, { ...state, blocked: true });
  return { decision: 'block', reason: stopReason(res.proposals, res.daily) };
}

// proposals: [{ id, path }].
export function stopReason(proposals, daily = null) {
  const n = proposals.length;
  const head = (list) => `Intent Compass drafted ${n} proposed decision record(s) for uncommitted or recently touched code that has no recorded intent: ${list}.`;
  const tail = ' Some of these changes may predate this session; if the user did not discuss a change, leave its TODO and ask. For each: fill the Why ONLY with what the user actually said in this session (quote them) and set provenance: ai-suggested; otherwise leave the TODO and ask the user. Replace the TODO in the frontmatter `title:` line and in the `# ` heading, and the Decision, with the rule the change follows, in present tense. Do not set status: accepted — ask the user to run intent accept <id>. If a record is noise, tell the user; do not delete it.';
  let shown = n;
  const more = (k) => ` and ${n - k} more${daily ? ` (all listed in ${daily})` : ''}`;
  const list = (k) => proposals.slice(0, k).map((p) => `${p.id} (${p.path})`).join(', ') + (k < n ? more(k) : '');
  while (shown > 1 && head(list(shown)).length + tail.length > MAX_REASON) shown--;
  return head(list(shown)) + tail;
}
