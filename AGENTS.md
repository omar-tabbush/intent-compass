# Agent instructions

<!-- intent-compass:start hash=9bc98dc1b3 -->
## Intent Compass: read the why before you change code

This repo records its intent (decisions and the why behind them) in `intent-vault/`. Every agent follows these rules:

1. **Before editing a file**, run `intent why <file>` and read every accepted record it lists. Do not break an accepted decision without asking the user first.
2. **After editing files**, run `intent touch <files...>`. In Claude Code the hooks do this for you.
3. **When the user makes a load-bearing choice**, record it right away: `intent new <module> "<the rule, present tense>" --governs <paths> --why "<the user's own words>"`. To reverse a decision, add `--supersedes <id>`. Never edit an accepted record.
4. **At the end of a task**, run `intent capture`. In each proposed record, fill the *Why* only with what the user actually said in this session; otherwise leave the TODO and ask. Never set `status: accepted` yourself: the user confirms with `intent accept <id>`.
5. **Never invent a rationale.** If you do not know why code is the way it is, say "I don't know why this is here; it may be load-bearing" and ask.
6. Never delete or rename files in `intent-vault/`. The only hand edit there is filling the TODOs (title, Decision, Why) of a proposed record. Reversals are new records.
<!-- intent-compass:end -->
