---
id: root/0011
title: Start fresh and port small parts of the earlier Compass plugin
status: accepted
date: 2026-10-28
governs: [src/fm.mjs, src/commands/hook.mjs, src/importer.mjs]
provenance: ai-suggested
review_date: 2027-04-28
supersedes: []
tags: []
---
# Start fresh and port small parts of the earlier Compass plugin

## Context

TODO

## Decision

Start fresh and port small parts of the earlier Compass plugin

## Why — the intent

From the analysis (Claude, 2026-10-27): Compass scoped by module not paths, let the model pick IDs, edited old records to supersede, and had no path index; its hook skeleton, parser and import helpers were worth keeping.

## Alternatives rejected

Extend Compass in place.

## Consequences

TODO
