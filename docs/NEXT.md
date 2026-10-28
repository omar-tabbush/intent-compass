# What to build next

## Decisions waiting for you

These came out of the review. Each changes the contract, so none was built.

1. **Nested opt-in.** `intent init` inside a subfolder of an opted-in repo creates a second `.intent.json`. The parent's `capture` and `check` then also count that subfolder. Options:
   - refuse unless `--nested` is passed;
   - warn and go on;
   - support nested vaults properly, with the parent skipping them.
2. **Missing vault folder.** `why`, `check`, `capture`, `accept` and `index` now warn when the vault path is wrong. `touch` and the hook stay silent and create the folder. Should they refuse instead? Refusing breaks a repo that opts in with only `.intent.json`.
3. **Partial supersede.** Should a ref like `supersedes: [billing/0002 (the retry part only)]` leave the old record active? Today every supersede is full.
4. **Existing hook installs.** `init --hooks` does not rewrite a hook entry that already exists. Older installs keep the 10-second Stop timeout until the entry is removed and `init --hooks` runs again.

## Next features, in order

1. **CI template.** A GitHub Actions job that runs `intent check --min N` and `intent rules --check` on pull requests. A PR that drops the score then fails.
2. **SessionStart hook.** At the start of a session, list proposed records that are waiting for `intent accept`. They then get confirmed while the context is fresh, not weeks later.
3. **`governs` inference on import.** Imported module notes often name their code folder in prose. Propose a `governs:` for each one as an `inferred-from-code` suggestion for a human to accept. Without it, an imported vault starts with every area uncovered.
4. **JSON data-file import.** Some vaults keep part of their decisions in `_data/*.json`. Read these as records, as the markdown reader already does.
5. **Branch-safe IDs.** Two branches can both allocate `billing/0004`. The index reports the duplicate. A merge-time renumber (a new record that supersedes, never an edit) would resolve it.
6. **Dashboard.** A static HTML page made from `index.json`: score over time, coverage per area, records waiting for a human.
7. **Install story.** Today it is `git clone` + `npm install -g <folder>`. Options: a one-line install script, or a private npm package if you ever want one. Nothing is published.
8. **Multi-repo vaults.** One vault shared by a backend and a frontend repo, with `governs` paths prefixed by repo name.
