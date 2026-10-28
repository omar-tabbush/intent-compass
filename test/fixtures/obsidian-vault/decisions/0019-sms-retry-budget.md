---
id: 0019
status: decided
date: 2026-01-20
tags: [notifications]
---
# SMS reminders retry at most three times

## Decision

A failed SMS reminder is retried at most three times, 10 minutes apart.

## Why — the intent

Customers complained about duplicate texts when the carrier was slow to acknowledge.

## Consequences / what an agent must NOT do

- Do not raise the retry count without asking support first.
