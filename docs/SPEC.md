# Intent Compass — specification

The contract every part of the tool is built against. If code and this file disagree, fix one of them in the same commit.

## 1. Principles (non-negotiable)

1. **Files are the truth.** Markdown records are the source. `index.json` and the `<!-- intent:generated:* -->` regions are derived and can be rebuilt at any time.
2. **Append-only.** The tool never edits the *Decision* or *Why* of an existing record, and never deletes a file. A reversed decision gets a new record with `supersedes:`. The old record's effective status is derived, not written.
   - The one allowed edit is `intent accept`: it flips a `proposed` record's `status` value to `accepted`. Only a plain `proposed` (or `draft`) value flips; a trailing `# comment` on the line stays.
   - Generated regions between markers may be rewritten.
   - Daily notes may be appended to.
3. **Never invent a rationale.** Code-generated text is limited to facts: file lists, dates, diff stats. The *Why* of a generated record is always the TODO marker (§4) until a human states it.
4. **Silent unless opted in.** A repo opts in with `.intent.json` at its root. `intent hook` exits 0 with no output anywhere else. Other commands print one line to stderr and exit 1.
5. **Zero dependencies.** Node ≥ 18.17, ESM, built-ins only.
6. **Obsidian-friendly.** The vault is plain markdown with YAML frontmatter and `[[wikilinks]]`. Any folder can be opened as an Obsidian vault.
7. **Import never modifies the source.** It reads from the source and writes only into the target vault. It refuses when the target is inside the source, or the source is inside the target.

## 2. Files

```
<repo>/
  .intent.json                      # opt-in marker + config
  AGENTS.md / CLAUDE.md             # rules block between markers (intent rules)
  .claude/settings.local.json       # optional Claude Code hooks (intent init --hooks)
  .claude/skills/intent-compass/    # optional skill copy (intent init --skill)
  intent-vault/                     # default vault; config.vault may point anywhere
    intent-vault.md                 # hub (generated region inside)
    decisions/NNNN-slug.md          # cross-cutting records, namespace "root"
    modules/<m>/<m>.md              # module note: governs + generated decision list
    modules/<m>/decisions/NNNN-slug.md
    daily/YYYY-MM-DD.md             # session log; capture appends
    index.json                      # generated; never written over an index.json that is not an intent index
    .gitignore                      # contains ".cache/"
    .cache/session.jsonl            # touched files, one appended line per touch (not committed)
    .cache/hook-<session>.json      # per-session (and per-subagent) hook state (not committed)
```

### `.intent.json`

```json
{
  "version": 1,
  "vault": "intent-vault",
  "codeRoots": ["src"],
  "areaDepth": 1,
  "ignore": ["node_modules/**", "dist/**"],
  "reviewMonths": 6,
  "proposedMaxDays": 14,
  "rulesFiles": ["AGENTS.md", "CLAUDE.md"]
}
```

Missing or wrong-typed keys take the defaults in `src/config.mjs` (a string where a list is expected is a one-item list). `vault` is relative to the repo root, or absolute; it may not be the repo root or a folder that contains it. Bad JSON is an error that names the file. `areaDepth: 0` makes each code root one area, for `check` and `capture` alike.

### Decision record

```markdown
---
id: billing/0003
title: Refunds go back to the original payment method
status: accepted            # proposed | accepted | superseded | deprecated
date: 2026-10-01
module: billing
governs: [src/billing/refunds/**]
provenance: human           # human | ai-suggested | inferred-from-code | imported
review_date: 2027-04-01
supersedes: [billing/0001]
tags: [payments]
---
# Refunds go back to the original payment method

## Context
## Decision
## Why — the intent
## Alternatives rejected
## Consequences
```

- **IDs** are `<namespace>/<NNNN>`.
  - The namespace is the module folder, or `root` for `decisions/` at the vault root.
  - Numbers are allocated by `nextNumber()` and never chosen by a model. It counts declared IDs `<ns>/NNNN` wherever their file is, and the filename numbers of the namespace's folder.
  - A filename number is padded to four digits (`001-x.md` is `root/0001`). A filename that starts with a date (`2023-10-05-x.md`, `20231005-x.md`) has no number: its ID is `<namespace>/<file name>`.
  - A note in a decisions folder with no number, status, declared `id` or `## Decision` section, or named `README`/`index`, is not a record: the index skips it and reports a `parse` problem.
- **`governs`** holds repo-relative paths or globs (§5).
- The reader is tolerant. It also accepts:
  - **schema A**: no frontmatter, with `- Status:` / `- Date:` / `- Module: [[m]]` bullets in the body;
  - **schema B**: `superseded-by`, `id: 0004`;
  - generated records with `status: decided`;
  - body bullets whose value goes on over indented lines (`- Supersedes:` then `  [[0001-x]]`);
  - folded and literal YAML scalars (`title: >`).
- **Free-text statuses.** A negated status (`Not accepted`, `no longer active`, `unapproved`) and a rejected or abandoned proposal (`Proposal rejected`, `Draft (abandoned)`) are never active.

### Module note

```markdown
---
type: module
module: billing
governs: [src/billing/**]
---
# billing
Free text: constraints, open questions.

<!-- intent:generated:decisions:start -->
## Decisions
- [[modules/billing/decisions/0003-refunds|billing/0003]] — Refunds go back… *(accepted)*
<!-- intent:generated:decisions:end -->
```

## 3. Library API (src/)

| Module | Exports |
|---|---|
| `fm.mjs` | `splitFrontmatter(text) → {data, body, hasFrontmatter}`; `parseYaml(src)`; `stringifyFrontmatter(data) → "---\n…\n---\n"`; `sections(body) → {title, list:[{heading, text}], get(re)}`; `unwiki(s)` |
| `glob.mjs` | `normalizePath(p)` (resolves `.` and `..`); `hasGlob(p)`; `globToRegex(p)`; `matchPath(pattern, file)`; `isUnder(file, dir)`; `globBase(pattern)` |
| `config.mjs` | `CONFIG_FILE`; `DEFAULTS`; `findRoot(start)`; `loadContext(cwd) → ctx \| null` (throws when the vault contains the repo); `readConfig(root)`; `vaultWarning(ctx)` |
| `walk.mjs` | `listFiles(ctx, relDir='') → string[]` (repo-relative posix, skips .git, node_modules, ignore globs and the vault) |
| `vault.mjs` | `loadVault(ctx) → {records, modules, dailies, problems}`; `normalizeStatus(raw)`; `parseRecord(rel, text, opts)`; `parseModule(rel, text)`; `looksLikeRecord(record, body)`; `validDate(s)`; `TODO_WHY` |
| `index.mjs` | `buildIndex(vault) → index`; `loadIndex(ctx)`, which rebuilds from files and returns the index; `writeIndex(ctx, index)` (refuses a foreign `index.json`); `indexWritable(file)`; `governing(index, ctx, relPath, {isDir}) → {path, isDir, items:[{record, reasons:[…]}], modules:[…]}`; `shallowMention(ctx, reasons)`; `ACTIVE` (set of active statuses) |
| `ids.mjs` | `slugify(title)`; `nextNumber(index, ns) → "0004"`; `freeNumber(vaultDir, ns, num)`; `fileNumber(name)`; `recordRelPath(ns, num, slug)` (vault-relative); `validModuleName(name)` (not `root`, `decisions`, `modules` or `daily`) |
| `record.mjs` | `renderRecord(meta, sectionsObj) → markdown`; `SECTION_ORDER` |
| `generated.mjs` | `replaceRegion(text, name, content) → text \| null` (markers count only as whole lines, and only one start line before one end line is rewritten); `brokenRegion(text, name)`; `region(name, content)`; `syncGenerated(ctx, index)` (rewrites the hub and module regions; returns changed files; adds a `broken-markers` problem for a note it leaves alone) |
| `git.mjs` | `isGitRepo(root)`; `changedFiles(root)` (unstaged + staged + untracked, repo-relative; read with `-z`, so names are never C-quoted, and `--no-renames`, so a move lists both paths); `lastChangeMap(root) → Map(file → UTC day of the last commit)`; `git(root, args)` |
| `io.mjs` | `makeIO({cwd, env, stdout, stderr}) → io`; `parseArgs(argv) → {positional, flags, late, errors}`; `list(flag)` (comma list); `captureIO()` (tests) |
| `rules.mjs` | `rulesBody(ctx)`; `rulesBlock(ctx)`; `blockState(ctx, text)`; `rulesStatus(ctx) → [{file, state: ok\|outdated\|missing\|no-file\|skipped}]`; `applyRules(ctx, {create}) → [{file, action}]`; `rulesPath(ctx, file)` (null outside the repo or in the vault) |
| `session.mjs` | `ensureCache(ctx)`; `readSession(ctx)`; `touch(ctx, paths, now)` (appends to `session.jsonl`); `claimSession(ctx)`; `clearSession(ctx)`; `readHookState(ctx, sessionId)`; `writeHookState(ctx, sessionId, state)` |
| `commands/_shared.mjs` | `notOptedIn(io)` (stderr line, returns 1); `refresh(ctx) → index` (rebuild and write `index.json` and the generated regions) |

`index` shape:

```js
{
  version: 1,
  records: [{ id, ns, num, path /* vault-relative */, module, title, status /* as declared, normalized */,
              statusRaw, effectiveStatus, date, reviewDate, provenance, governs: [], refs: [],
              supersedes: [ids], supersededBy: [ids], pendingReplacements: [ids], tags: [],
              missingWhy: bool, schema: 'frontmatter'|'body-bullets'|'none' }],
  modules: [{ name, path, title, governs: [], decisions: [ids] }],
  problems: [{ kind, path, message }]   // duplicate-id, unresolved-ref, parse, broken-markers
}
```

**Supersede refs** resolve to the record they name. A bare ID or number names every record with that ID; a file name or path names that one file. A folder in the ref (`modules/<m>/…`, `decisions/…`, any case) sets the namespace. A trailing qualifier (`0001 (the backoff part only)`, `[[0001-x]] — only Y`) is ignored. A path whose folders name no namespace, or whose file is in another namespace, is an `unresolved-ref`.

`ACTIVE = new Set(['accepted', 'unknown'])`. Effective status is `superseded` when an active record lists it in `supersedes`, or when the record itself declares `status: superseded` / `superseded-by`.

## 4. Commands

Every command module in `src/commands/<name>.mjs` exports:

```js
export async function run({ positional, flags }, io) → exit code (number)
// io: { cwd, env, now: Date, out(line), err(line), readStdin(): Promise<string> }
```

`io.now` comes from `INTENT_NOW` when set (tests), otherwise the current time.

**Arguments.** Every command but `hook` takes `--help` (or `-h`): it prints the command's usage and exits 0 without running anything. An unknown flag, or a value flag given twice, exits 2 before anything runs; the list flags `--governs`, `--tags`, `--supersedes` and `--code` add up instead. A value may start with `--` unless it looks like a flag (`--why "--no-verify is banned"`). A boolean flag given as `--x=false` (or `0`, `no`, `off`) is off. `intent hook` takes any arguments and never fails on them.

**Missing vault.** `why`, `check`, `capture`, `accept` and `index` print one stderr line when the configured vault folder does not exist or has no hub, `decisions/` or `modules/` yet (a typo in `vault`). `touch` and `hook` stay silent.

| Command | Behaviour |
|---|---|
| `intent init [--vault DIR] [--code a,b] [--import SRC] [--hooks] [--skill] [--force] [--rules] [--json]` | Writes `.intent.json` and the vault skeleton if missing. Idempotent: never overwrites existing files. Each flag adds its piece. `--import` runs the importer. `--hooks` merges hooks into `.claude/settings.local.json` and keeps that file out of git (a line in `.gitignore`, or in `.git/info/exclude` when the repo has no `.gitignore`). `--skill` copies `skill/intent-compass/` to `.claude/skills/`; `--force` replaces skill files that differ. `--rules` runs `intent rules`. Refuses, before writing anything, a vault that is the repo root or contains it, and a vault folder whose `index.json` is not an intent index. |
| `intent import SRC [--dry-run]` | Copies records and module notes from an Obsidian-style vault into this vault. It normalizes frontmatter and keeps the body verbatim, wikilinks included. It adds `provenance: imported`, `source: <src-relative path>` and `imported_at`. It skips files that already exist with the same `source`. |
| `intent why PATH… [--json]` | Lists, for each path (file or folder), the records and module notes that govern it, active first, each with its file. Prints the record files to read; a mention of a whole code root is listed but not put among them. When only proposed records govern the path, it says to confirm one rather than write another. Exit 0; 1 when a path is outside the repo. |
| `intent check [--json] [--min N]` | Prints the intent-debt report and a 0–100 score. Exits 1 when the score is below `--min`. |
| `intent capture [--since REF] [--dry-run] [--json]` | Proposes records for changed code that no active record governs. The *Why* stays TODO. Appends to today's daily note and clears the session touch list. Tooling files (`.intent.json`, `.claude/`, rules files, `.gitignore`) are not code; a path with control characters is skipped and listed under `skipped`. |
| `intent touch PATH… [--verbose]` | Appends the paths to `.cache/session.jsonl`. A path with control characters is never stored. |
| `intent rules [--check] [--create] [--json]` | Writes or refreshes the rules block in each `rulesFiles` entry, creating `AGENTS.md` if missing (`--create` creates the others too). The block takes the file's line endings. An entry outside the repo or inside the vault is skipped. `--check` exits 1 when the block is missing or outdated, or the markers are broken. |
| `intent new MODULE "TITLE" [--governs a,b] [--supersedes ID] [--why TEXT] [--provenance P] [--status S] [--context T] [--decision T] [--alternatives T] [--consequences T] [--review DATE] [--tags a,b] [--json]` | Writes a new record with an allocated ID. Default status `proposed`. Default provenance `ai-suggested` when `CLAUDECODE` or `INTENT_AGENT` is set in the environment, else `human`. Creates the module note if missing. A module name in another case joins the existing module. `--governs` paths are repo-relative with `.`/`..` resolved; one that climbs out is refused. An argument after a flag (`--governs a b`) is refused, so it never ends up in the title. |
| `intent accept ID… [--json]` | Flips `status: proposed` (or `draft`) to `accepted` in those records, keeping a trailing `# comment`. Refuses any other status, including a qualified one such as `Proposal rejected` or `Pending removal`. |
| `intent index` | Rebuilds `index.json` and the generated regions. |
| `intent hook` | Claude Code hook entry. Reads the hook JSON on stdin and switches on `hook_event_name` (`PreToolUse`, `PostToolUse`, `Stop`). Never throws: on any error it exits 0 silently. |

`TODO_WHY = "TODO — not recorded. Ask the human why; do not guess."`

### Hook behaviour

- **PreToolUse** (Edit|Write|MultiEdit|NotebookEdit): run `governing` on `tool_input.file_path`. When active records govern it, and the file was not already shown to this agent in this session (a subagent, by `agent_id`, has its own list), print:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<summary + files to read>"}}
  ```

  Never block the edit. Claude Code adds this context next to the tool result, so it arrives after the edit ran: the text says "you just edited" and asks the agent to revert or ask if the edit breaks an accepted record. `intent why` before editing shows it first. A record that only mentions a whole code root in its body is not listed.
- **PostToolUse**: touch the file. No output.
- **Stop**: if `stop_hook_active`, exit. Otherwise run capture over touched files plus the git working-tree changes, on every Stop. If at least one new proposal was written and this session has not blocked yet, print `{"decision":"block","reason":…}` telling the agent:
  - which proposals were written (ID and path), and that some changes may predate the session;
  - to fill *Why* only from what the user said in this session, setting `provenance: ai-suggested`;
  - to leave TODO and ask the user otherwise;
  - never to set `accepted`.

  The per-session marker is written only after a successful capture. Block at most once per session; later Stops still capture, without blocking. A daily-note section that repeats the last one is not appended again.

## 5. Globs

- `**` matches across folders; `*` and `?` match within a segment; `{a,b}` (with a comma) is a choice.
- Nothing else is glob syntax: `src/app/[id]` and `src/{legacy}` are plain paths.
- `.` and `..` segments are resolved; a path that climbs out of the repo matches nothing.
- A plain path with no glob characters matches itself and everything below it.
- A trailing `/` means the folder and everything below it.
- Paths are repo-relative posix with no leading `./`.

## 6. Intent-debt check

The score is 100 minus the penalties below, rounded and clamped to 0–100. It is never 100 while any penalty applies (99 at most). The output shows each line with its penalty and the record file.

| Finding | Penalty |
|---|---|
| Uncovered code areas | 40 × (uncovered ÷ total areas) |
| Drift: an active record whose governed files changed after its `date` | 3 each, cap 20 |
| Overdue `review_date` | 2 each, cap 10 |
| Dead `governs` (matches no file) | 2 each, cap 10 |
| `proposed` older than `proposedMaxDays` | 1 each, cap 5 |
| Active record with no rationale | 1 each, cap 10 |
| Unreachable record (no `governs` and no module note with `governs`), meaning no agent is ever pointed at it | 0.5 each, cap 5 |
| Duplicate IDs / unresolved supersedes | 3 each, cap 10 |
| Rules block missing or outdated in a `rulesFiles` entry | 5 each, cap 10 |

**Areas:** for each `codeRoots` entry, the folders `areaDepth` levels below it. A root with no sub-folders is itself one area. An area is covered when an active record, or a module note, governs at least one file in it.
