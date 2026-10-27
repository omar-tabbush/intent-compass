# Intent Compass — specification

The contract every part of the tool is built against. If code and this file disagree, fix one of them in the same commit.

## 1. Principles (non-negotiable)

1. **Files are the truth.** Markdown records are the source. `index.json` and the `<!-- intent:generated:* -->` regions are derived and can be rebuilt at any time.
2. **Append-only.** The tool never edits the *Decision* or *Why* of an existing record, and never deletes a file. A reversed decision gets a new record with `supersedes:`. The old record's effective status is derived, not written.
   - The one allowed edit is `intent accept`: it flips a `proposed` record's `status` line to `accepted`.
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
    index.json                      # generated
    .gitignore                      # contains ".cache/"
    .cache/session.json             # touched files (not committed)
    .cache/hook-<session>.json      # per-session hook state (not committed)
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

Missing keys take the defaults in `src/config.mjs`. `vault` is relative to the repo root, or absolute.

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
  - Numbers are allocated by `nextNumber()` and never chosen by a model.
- **`governs`** holds repo-relative paths or globs (§5).
- The reader is tolerant. It also accepts:
  - **schema A**: no frontmatter, with `- Status:` / `- Date:` / `- Module: [[m]]` bullets in the body;
  - **schema B**: `superseded-by`, `id: 0004`;
  - generated records with `status: decided`.

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
| `glob.mjs` | `normalizePath(p)`; `hasGlob(p)`; `globToRegex(p)`; `matchPath(pattern, file)`; `isUnder(file, dir)`; `globBase(pattern)` |
| `config.mjs` | `CONFIG_FILE`; `DEFAULTS`; `findRoot(start)`; `loadContext(cwd) → ctx \| null`; `readConfig(root)` |
| `walk.mjs` | `listFiles(ctx, relDir='') → string[]` (repo-relative posix, skips .git, node_modules, ignore globs and the vault) |
| `vault.mjs` | `loadVault(ctx) → {records, modules, dailies, problems}`; `normalizeStatus(raw)`; `parseRecord(rel, text, opts)`; `parseModule(rel, text)`; `TODO_WHY` |
| `index.mjs` | `buildIndex(vault) → index`; `loadIndex(ctx)`, which rebuilds from files and returns the index; `writeIndex(ctx, index)`; `governing(index, ctx, relPath) → {path, isDir, items:[{record, reasons:[…]}], modules:[…]}`; `ACTIVE` (set of active statuses) |
| `ids.mjs` | `slugify(title)`; `nextNumber(index, ns) → "0004"`; `recordRelPath(ns, num, slug)` (vault-relative) |
| `record.mjs` | `renderRecord(meta, sectionsObj) → markdown`; `SECTION_ORDER` |
| `generated.mjs` | `replaceRegion(text, name, content) → text \| null`; `region(name, content)`; `syncGenerated(ctx, index)` (rewrites the hub and module regions; returns changed files) |
| `git.mjs` | `isGitRepo(root)`; `changedFiles(root)` (unstaged + staged + untracked, repo-relative); `lastChangeMap(root) → Map(file → ISO date)`; `git(root, args)` |
| `io.mjs` | `makeIO({cwd, env, stdout, stderr}) → io`; `parseArgs(argv) → {positional, flags}` |

`index` shape:

```js
{
  version: 1,
  records: [{ id, ns, num, path /* vault-relative */, module, title, status /* as declared, normalized */,
              statusRaw, effectiveStatus, date, reviewDate, provenance, governs: [], refs: [],
              supersedes: [ids], supersededBy: [ids], pendingReplacements: [ids], tags: [],
              missingWhy: bool, schema: 'frontmatter'|'body-bullets'|'none' }],
  modules: [{ name, path, title, governs: [], decisions: [ids] }],
  problems: [{ kind, path, message }]   // duplicate-id, unresolved-ref, parse
}
```

`ACTIVE = new Set(['accepted', 'unknown'])`. Effective status is `superseded` when an active record lists it in `supersedes`, or when the record itself declares `status: superseded` / `superseded-by`.

## 4. Commands

Every command module in `src/commands/<name>.mjs` exports:

```js
export async function run({ positional, flags }, io) → exit code (number)
// io: { cwd, env, now: Date, out(line), err(line), readStdin(): Promise<string> }
```

`io.now` comes from `INTENT_NOW` when set (tests), otherwise the current time.

| Command | Behaviour |
|---|---|
| `intent init [--vault DIR] [--code a,b] [--import SRC] [--hooks] [--skill] [--rules]` | Writes `.intent.json` and the vault skeleton if missing. Idempotent: never overwrites existing files. Each flag adds its piece. `--import` runs the importer. `--hooks` merges hooks into `.claude/settings.local.json`. `--skill` copies `skill/intent-compass/` to `.claude/skills/`. `--rules` runs `intent rules`. |
| `intent import SRC [--dry-run]` | Copies records and module notes from an Obsidian-style vault into this vault. It normalizes frontmatter and keeps the body verbatim, wikilinks included. It adds `provenance: imported`, `source: <src-relative path>` and `imported_at`. It skips files that already exist with the same `source`. |
| `intent why PATH… [--json]` | Lists, for each path (file or folder), the records and module notes that govern it, active first. Exit 0. Prints the record files to read. |
| `intent check [--json] [--min N]` | Prints the intent-debt report and a 0–100 score. Exits 1 when the score is below `--min`. |
| `intent capture [--since REF] [--dry-run] [--json]` | Proposes records for changed code that no active record governs. The *Why* stays TODO. Appends to today's daily note and clears the session touch list. |
| `intent touch PATH…` | Appends the paths to `.cache/session.json`. |
| `intent rules [--check]` | Writes or refreshes the rules block in each `rulesFiles` entry, creating `AGENTS.md` if missing. `--check` exits 1 when the block is missing or outdated. |
| `intent new MODULE "TITLE" [--governs a,b] [--supersedes ID] [--why TEXT] [--provenance P] [--status S]` | Writes a new record with an allocated ID. Default status `proposed`. Creates the module note if missing. |
| `intent accept ID…` | Flips `status: proposed` to `accepted` in those records. Refuses on any other status. |
| `intent index` | Rebuilds `index.json` and the generated regions. |
| `intent hook` | Claude Code hook entry. Reads the hook JSON on stdin and switches on `hook_event_name` (`PreToolUse`, `PostToolUse`, `Stop`). Never throws: on any error it exits 0 silently. |

`TODO_WHY = "TODO — not recorded. Ask the human why; do not guess."`

### Hook behaviour

- **PreToolUse** (Edit|Write|MultiEdit|NotebookEdit): run `governing` on `tool_input.file_path`. When active records govern it, and the file was not already shown this session, print:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<summary + files to read>"}}
  ```

  Never block the edit.
- **PostToolUse**: touch the file. No output.
- **Stop**: if `stop_hook_active`, exit. Otherwise run capture over touched files plus the git working-tree changes. If at least one new proposal was written, print `{"decision":"block","reason":…}` telling the agent:
  - which proposals were written;
  - to fill *Why* only from what the user said in this session, setting `provenance: ai-suggested`;
  - to leave TODO and ask the user otherwise;
  - never to set `accepted`.

  The per-session marker is written only after a successful capture. Block at most once per session.

## 5. Globs

- `**` matches across folders; `*` and `?` match within a segment.
- A plain path with no glob characters matches itself and everything below it.
- A trailing `/` means the folder and everything below it.
- Paths are repo-relative posix with no leading `./`.

## 6. Intent-debt check

The score is 100 minus the penalties below, clamped to 0–100. The output shows each line with its penalty.

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
