---
id: "0019"
status: accepted (partially superseded by 0020)
date: 2026-01-12
tags: [flags]
---
# Feature flags live in config

## Decision

Feature flags are keys in `config/flags.json`, reviewed in pull requests.

## Why — the intent

Flags change rarely and we want them in code review. Ravi: "A flag that nobody reviewed is a deploy nobody reviewed."

## Consequences / what an agent must NOT do

- Do not read flags from environment variables.
- Per-tenant rollouts moved to a service, see [[0020-flag-service-for-tenant-rollouts]].
