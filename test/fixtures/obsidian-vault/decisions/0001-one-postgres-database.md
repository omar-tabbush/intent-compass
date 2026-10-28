---
id: "0001"
status: superseded
date: 2025-03-02
module: platform
tags: [data, infra]
superseded-by: 0004
decided-by: Mara Quill
---
# One Postgres database for everything

## Decision

All services read and write one Postgres database. No per-service schemas.

## Why — the intent

We are four engineers. One database means one backup story and one place to look when a job goes missing. Mara: "I would rather scale a boring thing than debug three clever ones."

## What we rejected and why

- A database per service: too much operational weight for the team size.
- A document store for job notes: we already query notes by date and branch.

## Consequences / what an agent must NOT do

- Do not add a second database connection in `src/platform/db.ts`.
- Reporting queries later moved off the primary, see [[0004-reporting-read-replica]].
