# Intent Compass reference

Facts from `docs/SPEC.md`, shortened. The spec wins when they differ.

## Files

```
<repo>/
  .intent.json                      # opt-in marker + config
  AGENTS.md / CLAUDE.md             # rules block between markers (intent rules)
  .claude/settings.local.json       # optional Claude Code hooks (intent init --hooks)
  .claude/skills/intent-compass/    # optional copy of this skill (intent init --skill)
  intent-vault/                     # default vault; config "vault" may point anywhere
    intent-vault.md                 # hub (generated region inside)
    decisions/NNNN-slug.md          # cross-cutting records, namespace "root"
    modules/<m>/<m>.md              # module note: governs + generated decision list
    modules/<m>/decisions/NNNN-slug.md
    daily/YYYY-MM-DD.md             # session log; capture appends
    index.json                      # generated
    .cache/                         # session touch list and hook state, not committed
```

Files are the truth. `index.json` and everything between `<!-- intent:generated:* -->` markers are rebuilt from the records (`intent index`). Do not edit them by hand.

## `.intent.json`

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | Config format version |
| `vault` | `"intent-vault"` | Vault folder, relative to the repo root, or absolute; not the repo root itself |
| `codeRoots` | `["src"]` | Code folders; `intent check` and `intent capture` group files into areas below them |
| `areaDepth` | `1` | Folder levels below each code root that make one area |
| `ignore` | `node_modules/**`, `dist/**`, `build/**`, ... | Globs never listed as code |
| `reviewMonths` | `6` | Default gap between `date` and `review_date` |
| `proposedMaxDays` | `14` | Age after which a `proposed` record counts as stale |
| `rulesFiles` | `["AGENTS.md", "CLAUDE.md"]` | Files that carry the agent rules block |

Missing keys take the defaults.

## Decision record

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

- **IDs** are `<namespace>/<NNNN>`. The namespace is the module folder, or `root` for `decisions/` at the vault root. The tool allocates the number; never choose one yourself.
- **`governs`** holds repo-relative paths or globs (see Globs).
- **`supersedes`** lists the IDs this record replaces. The old record is never edited.
- **Missing Why.** A record with no stated reason keeps this exact line under `## Why — the intent`:

  ```
  TODO — not recorded. Ask the human why; do not guess.
  ```

- **Tolerant reader.** The tool also reads records with no frontmatter and `- Status:` / `- Date:` / `- Module: [[m]]` bullets in the body, records with `superseded-by` or a bare `id: 0004`, and generated records with `status: decided`.

## Statuses

| Status | Meaning |
|---|---|
| `proposed` | Written but not confirmed. The default for `intent new` and `intent capture`. |
| `accepted` | Confirmed by the user with `intent accept <id>`. Follow it. |
| `superseded` | Replaced by a later record. |
| `deprecated` | No longer applies. |

- **Active** means `accepted`, or a status the reader could not classify (`unknown`).
- **Effective status** is derived, not written. A record is effectively `superseded` when an active record lists it in `supersedes`, or when it declares `status: superseded` or `superseded-by` itself.
- **The one edit to an existing record** is `intent accept`: it flips `status: proposed` to `accepted` and changes nothing else. It refuses any other status.

## Provenance

| Value | Who wrote it |
|---|---|
| `human` | A person. |
| `ai-suggested` | An agent, with the Why taken from what the user said in the session. |
| `inferred-from-code` | `intent capture`, from the changed files. The Why stays TODO. |
| `imported` | `intent import`, which also adds `source:` and `imported_at`. |

## Module note

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

The module note lives at `modules/<m>/<m>.md`. Its `governs` points agents at the module, and the decision list between the markers is generated.

## Rules block

`intent rules` writes the agent rules between `<!-- intent-compass:start hash=… -->` and `<!-- intent-compass:end -->` in each `rulesFiles` entry. It creates `AGENTS.md` if it is missing. Text outside the markers is left alone. Do not edit inside the markers: `intent rules --check` reports an edited block as outdated. A file whose markers are broken (a start with no end, a stray end, two blocks) is never rewritten; fix the markers by hand.

## Globs

- `**` matches across folders; `*` and `?` match within one path segment.
- A plain path with no glob characters matches itself and everything below it.
- A trailing `/` means the folder and everything below it.
- Paths are repo-relative posix with no leading `./`.

Examples: `src/billing/**` and `src/billing` both cover `src/billing/a/b.ts`. `src/*.ts` covers `src/a.ts` but not `src/x/a.ts`.

## Commands

| Command | What it does |
|---|---|
| `intent init [--vault DIR] [--code a,b] [--import SRC] [--hooks] [--skill] [--rules]` | Writes `.intent.json` and the vault skeleton if missing; never overwrites. Each flag adds its piece. |
| `intent import SRC [--dry-run]` | Copies records and module notes from an Obsidian-style vault into this vault. Never modifies the source. |
| `intent why PATH… [--json]` | Lists the records and module notes that govern each file or folder, active first, and the files to read. |
| `intent check [--json] [--min N]` | Intent-debt report with a 0–100 score. Exits 1 when the score is below `--min`. |
| `intent capture [--since REF] [--dry-run] [--json]` | Proposes records for changed code that no active record governs. The Why stays TODO. Appends to today's daily note. |
| `intent touch PATH…` | Adds the paths to the session touch list. |
| `intent rules [--check]` | Writes or refreshes the rules block in each `rulesFiles` entry. `--check` exits 1 when a block is missing or outdated. |
| `intent new MODULE "TITLE" [--governs a,b] [--supersedes ID] [--why TEXT] [--provenance P] [--status S]` | Writes a new record with an allocated ID. Default status `proposed`. Creates the module note if missing. |
| `intent accept ID…` | Flips `proposed` to `accepted` in those records. |
| `intent index` | Rebuilds `index.json` and the generated regions. |
| `intent hook` | Claude Code hook entry. Reads the hook JSON on stdin. Never blocks an edit. |

Outside an opted-in repo, commands print one line to stderr and exit 1. `intent hook` exits 0 with no output there. `intent init` is how a repo opts in.

## Intent-debt score

`intent check` starts at 100 and subtracts:

| Finding | Penalty |
|---|---|
| Uncovered code areas | 40 × (uncovered ÷ total areas) |
| Drift: an active record whose governed files changed after its `date` | 3 each, cap 20 |
| Overdue `review_date` | 2 each, cap 10 |
| Dead `governs` (matches no file) | 2 each, cap 10 |
| `proposed` older than `proposedMaxDays` | 1 each, cap 5 |
| Active record with no rationale | 1 each, cap 10 |
| Unreachable record (no `governs` and no module note with `governs`) | 0.5 each, cap 5 |
| Duplicate IDs / unresolved supersedes | 3 each, cap 10 |
| Rules block missing, outdated or with broken markers in a `rulesFiles` entry | 5 each, cap 10 |

An area is covered when an active record, or a module note, governs at least one file in it.
