---
id: "0020"
status: Accepted
date: 2026-04-03
tags: [flags]
amends: ["0019"]
---
# Per-tenant rollouts use the flag service

## Decision

Flags that differ per tenant live in the flag service. Global flags stay in `config/flags.json`.

## Why — the intent

Large tenants asked to opt in to the new calendar before everyone else.

## What we rejected and why

- One config file per tenant: hundreds of files nobody reviews.
