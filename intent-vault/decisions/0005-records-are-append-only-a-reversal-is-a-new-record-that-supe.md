---
id: root/0005
title: "Records are append-only: a reversal is a new record that supersedes the old one"
status: accepted
date: 2026-10-28
governs: [src/index.mjs, src/commands/new.mjs, src/commands/accept.mjs, src/importer.mjs]
provenance: human
review_date: 2027-04-28
supersedes: []
tags: []
---
# Records are append-only: a reversal is a new record that supersedes the old one

## Context

The index derives the superseded status, so the old file is never edited.

## Decision

Records are append-only: a reversal is a new record that supersedes the old one

## Why — the intent

Omar's brief: "append-only (a reversed decision gets a new record and supersedes the old one), never deletes".

## Alternatives rejected

TODO

## Consequences

TODO
