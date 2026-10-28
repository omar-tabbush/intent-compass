---
id: "0004"
status: accepted
date: 2025-09-18
tags: [data]
supersedes: ["[[0001-one-postgres-database]]"]
relates: ["[[0048-money-as-integer-cents]]"]
---
# Reporting reads from a replica

## Decision

Reports and exports read from a read replica. The primary database serves the app only.

## Why — the intent

Month-end exports from the largest tenant locked the jobs table for minutes. Office staff could not book jobs while finance ran reports.

## What we rejected and why

- Caching reports: finance needs same-day numbers.

## Consequences / what an agent must NOT do

- Do not point report queries at the primary connection.
