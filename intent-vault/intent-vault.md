---
type: hub
---
# Intent vault

## What this is

This vault keeps the *why* of the code: decision records and module notes that people and AI agents read before they change code. The markdown files are the truth; `index.json` and the generated part below are rebuilt from them by `intent index`.

- `decisions/` holds cross-cutting records, `modules/<name>/` holds a module note and that module's records, `daily/` holds session notes.
- Before changing a file, run `intent why <file>` and read the records it lists.
- Records are append-only. Never edit the Decision or Why of an existing record and never delete one. To reverse a decision, write a new record that supersedes it.
- Never invent a rationale. A Why that nobody stated stays TODO until a human gives it.

<!-- intent:generated:hub:start -->
## Status

13 records: 13 accepted, 0 proposed, 0 superseded, 0 deprecated, 0 unknown.

## Modules

_None yet._

## Cross-cutting decisions

- [[decisions/0001-intent-compass-ships-as-an-agent-skill-plus-a-cli-not-a-mark|root/0001]] — Intent Compass ships as an agent skill plus a CLI, not a marketplace plugin *(accepted)*
- [[decisions/0002-capture-runs-on-every-edit-and-at-the-end-of-each-session|root/0002]] — Capture runs on every edit and at the end of each session *(accepted)*
- [[decisions/0003-the-vault-lives-in-the-repo-by-default-and-the-user-can-poin|root/0003]] — The vault lives in the repo by default and the user can point it at another folder *(accepted)*
- [[decisions/0004-records-start-as-proposed-until-the-user-confirms-them|root/0004]] — Records start as proposed until the user confirms them *(accepted)*
- [[decisions/0005-records-are-append-only-a-reversal-is-a-new-record-that-supe|root/0005]] — Records are append-only: a reversal is a new record that supersedes the old one *(accepted)*
- [[decisions/0006-the-tool-never-invents-a-rationale|root/0006]] — The tool never invents a rationale *(accepted)*
- [[decisions/0007-the-tool-is-silent-in-folders-that-have-not-opted-in|root/0007]] — The tool is silent in folders that have not opted in *(accepted)*
- [[decisions/0008-import-never-modifies-the-source-vault|root/0008]] — Import never modifies the source vault *(accepted)*
- [[decisions/0009-the-cli-has-zero-dependencies-and-runs-on-plain-node|root/0009]] — The CLI has zero dependencies and runs on plain Node *(accepted)*
- [[decisions/0010-client-material-never-enters-this-repo|root/0010]] — Client material never enters this repo *(accepted)*
- [[decisions/0011-start-fresh-and-port-small-parts-of-the-earlier-compass-plug|root/0011]] — Start fresh and port small parts of the earlier Compass plugin *(accepted)*
- [[decisions/0012-ids-are-allocated-by-the-cli-and-numbered-per-module|root/0012]] — IDs are allocated by the CLI and numbered per module *(accepted)*
- [[decisions/0013-the-claude-code-hook-never-approves-or-denies-a-tool-call|root/0013]] — The Claude Code hook never approves or denies a tool call *(accepted)*

## Waiting for a human

_Nothing proposed._
<!-- intent:generated:hub:end -->
