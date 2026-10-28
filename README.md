# Intent Compass

**Intent debt** is the gap between what the builders of an app meant and what is written down: the goals, rules and the *why* behind each decision. When a small team ships with AI coding agents, that why lives only in people's heads, and no later refactor can recover it. Intent Compass prevents the debt: it keeps decision records next to the code, shows agents the governing decisions when they first edit a file, and drafts new records at the end of each session for a human to confirm.

It is a zero-dependency Node CLI (`intent`) plus an agent skill. It works with Claude Code (hooks + skill) and with any other agent that reads `AGENTS.md` or Agent Skills.

## Install

Needs Node 18.17 or newer. No dependencies.

```bash
git clone https://github.com/omar-tabbush/intent-compass.git ~/dev/intent-compass
```

```bash
npm install -g ~/dev/intent-compass
```

Then, in the repo you want to protect:

```bash
intent init --rules --hooks --skill
```

- `--rules` writes the agent rules block into `AGENTS.md` (and `CLAUDE.md` if it exists).
- `--hooks` adds Claude Code hooks to `.claude/settings.local.json` (personal: added to `.gitignore`, or to `.git/info/exclude` when the repo has no `.gitignore`).
- `--skill` copies the skill into `.claude/skills/intent-compass/`. For every project at once, copy `skill/intent-compass/` to `~/.claude/skills/` instead.

Already keep an Obsidian vault? Point the vault at it with `intent init --vault ../my-vault`, or copy it in with `intent init --import ../my-vault`. Import never changes the source.

## The commands

| Command | What it does |
|---|---|
| `intent init` | Opts the repo in: `.intent.json` and an Obsidian-friendly vault (`intent-vault/` by default). Idempotent. `--import SRC` copies an existing vault in. |
| `intent capture` | Proposes a record for each changed code area that no decision governs. The *Why* stays TODO: the tool never invents a rationale. Runs automatically at the end of a Claude Code session. |
| `intent why <path>` | Lists the decisions and module notes that govern a file or folder, active ones first, and the files to read before editing. |
| `intent check` | Intent-debt report with a 0–100 score: uncovered code areas, code changed after its decision, overdue reviews, dead paths, stale proposals, missing whys, missing rules blocks. `--min N` fails CI below N. |
| `intent rules` | Writes or refreshes the short rules block in `AGENTS.md` / `CLAUDE.md` that tells agents to run `intent why` before editing. `--check` for CI. |

Also included:
- `intent new <module> "<rule>" --governs <globs> --why "<the user's words>"` records a decision, with the ID allocated by the CLI.
- `intent accept <id>` confirms a proposed record.
- `intent touch <files>` marks files changed in this session.
- `intent index` rebuilds the index.
- `intent hook` is the Claude Code hook entry.

`intent <command> --help` prints a command's flags without running it. A misspelled flag is an error, so a typo never writes anything.

### What runs when

| Moment | Claude Code (hooks) | Other agents (`AGENTS.md` rules / skill) |
|---|---|---|
| First edit of a file | `PreToolUse` adds the governing decisions next to the tool result, once per file (run `intent why` before editing to see them first) | agent runs `intent why <file>` |
| After an edit | `PostToolUse` runs `intent touch` | agent runs `intent touch <files>` |
| End of each turn | `Stop` runs `intent capture`; the first time it drafts records in a session, it asks the agent to fill the Why **only from what the user said** | agent runs `intent capture` |
| Confirm | the user runs `intent accept <id>` | same |

The hook only adds context. It never approves, denies or blocks an edit, and it is silent in any folder without `.intent.json`.

## File format

Plain markdown with YAML frontmatter, committed with the code. Files are the truth. `index.json` and the regions between `<!-- intent:generated:... -->` markers are rebuilt from them.

```
.intent.json                         # opt-in + config (vault, codeRoots, areaDepth, reviewMonths, ...)
intent-vault/
  intent-vault.md                    # hub: status, modules, cross-cutting, waiting for a human
  decisions/0001-slug.md             # cross-cutting records, IDs root/NNNN
  modules/billing/billing.md         # module note: governs + generated decision list
  modules/billing/decisions/0001-slug.md   # IDs billing/NNNN
  daily/2026-10-28.md                # capture appends what it proposed
  index.json                         # generated
```

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

**Rules the tool keeps:**
- **Append-only.** A reversal is a new record with `supersedes:`. The old record's superseded status is derived by the index, and its file is never edited.
- **Never deletes.**
- **Never invents a why.**
- **Silent outside opted-in repos.**
- **Tolerant reader.** It also reads records without frontmatter (`- Status: accepted` bullets), per-module numbering, free-text statuses and every common `superseded-by` link format.

The full contract is in [docs/SPEC.md](docs/SPEC.md).

## 60-second demo

The demo is a fictional bakery backend with seeded intent debt.

```bash
cd ~/dev/intent-compass && cd "$(node examples/make-demo.mjs)"
```

```bash
intent check
```

Expected result: `Intent debt: 77/100`, with:
- one uncovered area (`src/notifications`);
- drift (`src/orders/pricing.js` changed on 2026-08-02, after `orders/0001`);
- an overdue review;
- a dead `governs` path;
- a stale proposal;
- no rules block in `AGENTS.md`.

```bash
intent why src/payments/refund.js
```

Shows `payments/0002` (accepted), `payments/0001` (superseded by it) and the files to read before editing.

```bash
intent rules && intent capture
```

Writes the rules block, then proposes `root/0002` for the uncommitted change in `src/notifications`, with the Why left as TODO. A human opens `intent-vault/decisions/0002-captured-src-notifications.md` and replaces the TODOs: the title (the frontmatter `title:` line and the `# ` heading), the Decision, and the Why in their own words. Then they confirm:

```bash
intent accept root/0002 && intent check
```

The score rises to 92. (Accepting with the Why still TODO works too, with a warning, and gives 91: the record counts as having no why.) Open `intent-vault/` in Obsidian to browse the same records as linked notes.

## Development

```bash
npm test
```

The tests use `node:test` and cover parsing, the index, `why`, `check`, `capture`, the hook, `init`, import and `rules`.

The project records its own decisions in [intent-vault/](intent-vault/intent-vault.md). Run `intent why <file>` before you change one.
