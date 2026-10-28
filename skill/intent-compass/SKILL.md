---
name: intent-compass
description: Read and record the why behind code with the intent CLI (Intent Compass decision records). Use before editing code in a repo that has a .intent.json file or an intent-vault/ folder, to read the decisions that govern the files you will change. Use when the user states a reason for a design choice ("we do X because Y", "never do Z", "always use W"), to record it in the user's own words. Use when reversing or replacing an earlier decision. Use at the end of any task that changed code, to capture changes no decision covers and ask the user to confirm them. Never invents a rationale.
---

# Intent Compass

Intent debt is code whose reason was never written down, so the next person or agent "fixes" something that was load-bearing. This repo keeps the why as decision records in a markdown vault next to the code, and you read them before you change code.

## When this applies

- The repo has `.intent.json` at its root (or in a parent folder). The vault is the folder named by its `vault` key, `intent-vault/` by default.
- No `.intent.json`: do nothing here. Do not run `intent init` unless the user asks for it.

## If `intent` is not on PATH

Check with `command -v intent`. If it is missing, ask the user before installing anything, then use one of:

```sh
npm install -g <path-to-intent-compass>
node <path-to-intent-compass>/bin/intent.mjs <command> ...
```

## The loop

### 1. Before editing a file, read its intent

```sh
intent why <file-or-folder>
```

- Read every file listed under `Read before editing:`.
- `accepted`: follow it. If the task needs to break it, stop and ask the user first.
- `proposed`: not confirmed yet. Treat it as a hint, not a rule.
- `superseded`: history only. Read the record that replaced it.
- `(why not recorded)`: the reason is unknown. Do not fill it in from guesses.

### 2. After editing, mark the files

```sh
intent touch <file> [<file> ...]
```

In Claude Code with the intent hooks installed this happens for you. Running it again is harmless.

### 3. Record load-bearing choices when the user makes them

When the user says "we do X because Y" or "never do Z", record it right away:

```sh
intent new <module> "<the rule, present tense>" --governs <paths-or-globs> --why "<the user's own words>" --provenance ai-suggested
```

- `<module>` is the module folder name, or `root` for a rule that cuts across modules.
- `--governs` takes repo-relative paths or globs, comma separated (`--governs src/a,src/b`; a second path after a space is refused). A folder path covers everything below it. Run `intent why <path>` afterwards to confirm the record shows up.
- `--why` is the user's words, quoted as closely as you can. No user reason means no `--why`: the Why stays TODO.
- The record starts as `proposed`. Do not pass `--status accepted`.
- To reverse a decision, write a new record with `--supersedes <id>`. Never edit the old one; its status is derived.

### 4. At the end of a task that changed code, capture

```sh
intent capture
```

It drafts `proposed` records for changed code that no active record governs. Their Why is the TODO marker.

- The only vault edit you make by hand is in a `proposed` record written in this session:
  - replace the TODO in the frontmatter `title:` line and in the `# ` heading, and the TODO under `## Decision`, with the rule the change follows, in present tense;
  - replace the TODO under `## Why — the intent` with what the user said in this session, and set `provenance: ai-suggested`.
- If the user did not say why, leave the TODO and ask them.
- Tell the user which records you wrote and ask them to run `intent accept <id>`.

### 5. Hard rules

- Never invent a rationale. If you do not know why code is the way it is, say exactly: "I don't know why this is here; it may be load-bearing." Then ask.
- Never delete, rename or rewrite files in the vault, apart from the TODO edits in step 4. Reversals are new records.
- Never set `status: accepted` yourself, in a file or with a flag. The user confirms with `intent accept <id>`.
- Never edit `index.json` or text between `<!-- intent:generated:... -->` markers. They are rebuilt from the records.

## Hooks (Claude Code)

With `intent init --hooks`, the repo's hooks do parts of the loop:

- When you first edit a governed file, the hook adds the governing records next to the tool result, so you read them after that edit ran. Read the files it names; if your edit breaks an accepted record, tell the user and revert or ask. Run `intent why` before editing to see them first.
- After an edit, it runs the touch for you.
- When you stop, it runs capture. The first time in a session that capture drafts new proposals, it blocks once with their IDs and paths. Fill their TODOs as in step 4: the Why only from the user's words, or leave it and ask. Some changes may predate the session; do not invent a reason for those.

## Health

```sh
intent check           # intent-debt report and a 0-100 score
intent check --min 70  # exits 1 when the score is below 70
intent rules --check   # exits 1 when the rules block in AGENTS.md / CLAUDE.md is missing or outdated
intent index           # rebuild index.json and generated regions from the files
```

Report the score and the top findings to the user. Fix on your own only what needs no rationale, such as running `intent rules`. Ask the user for every missing Why.

## Worked example (fictional)

The user, working on the Quillby ferry-booking app, says: "Cache fare quotes for 60 seconds at most. The port authority changes fares without notice."

```sh
$ intent why src/fares/cache.ts
No recorded intent for src/fares/cache.ts.
```

You change the cache TTL, then:

```sh
$ intent touch src/fares/cache.ts
$ intent new fares "Fare quotes are cached for at most 60 seconds" --governs src/fares/cache.ts --why "The port authority changes fares without notice." --provenance ai-suggested
Created fares/0001 (proposed): intent-vault/modules/fares/decisions/0001-fare-quotes-are-cached-for-at-most-60-seconds.md
$ intent capture
```

You tell the user: "I recorded fares/0001 with your reason. Please confirm it with `intent accept fares/0001`."

Months later the user says: "Raise it to five minutes; the authority now publishes fares a day ahead." `intent why src/fares/cache.ts` shows fares/0001 as accepted, and the user has asked to change it, so you write a new record and leave fares/0001 alone:

```sh
$ intent new fares "Fare quotes are cached for at most five minutes" --governs src/fares/cache.ts --supersedes fares/0001 --why "The authority now publishes fares a day ahead." --provenance ai-suggested
```

## Reference

Record format, module notes, glob rules, statuses, provenance values and the full command table: [reference.md](reference.md).
