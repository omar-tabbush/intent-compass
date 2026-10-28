---
id: root/0008
title: Import never modifies the source vault
status: proposed
date: 2026-10-28
governs: [src/importer.mjs, src/commands/import.mjs]
provenance: human
review_date: 2027-04-28
supersedes: []
tags: []
---
# Import never modifies the source vault

## Context

Import writes only into the target vault and refuses overlapping folders.

## Decision

Import never modifies the source vault

## Why — the intent

Omar's brief: import an existing Obsidian-style vault "without ever modifying the source".

## Alternatives rejected

TODO

## Consequences

TODO
