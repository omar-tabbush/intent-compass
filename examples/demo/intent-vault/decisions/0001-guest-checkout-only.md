---
id: root/0001
title: Guest checkout only, no customer accounts
status: accepted
date: 2026-01-10
module: root
governs: [src/auth/**]
provenance: human
review_date: 2099-01-01
supersedes: []
tags: [auth, privacy]
---
# Guest checkout only, no customer accounts

## Context

Most orders are one-off pickups by people who will not come back for months.

## Decision

Customers check out as guests with an email. There are no passwords or accounts.

## Why — the intent

Mira: "Nobody wants an account to buy a loaf of bread, and I don't want to store passwords."

## Alternatives rejected

- Optional accounts: more code to secure for few returning customers.

## Consequences

- Do not add a users table or password fields.
