---
id: "0003"
status: accepted
date: 2025-11-02
module: invoicing
supersedes: [[0001-invoice-numbers-are-gapless]]
tags: [numbering]
---
# Each branch has its own gapless invoice sequence

## Decision

Invoice numbers are gapless per branch, prefixed with the branch code.

## Why — the intent

Tenants with several branches file taxes per branch. One sequence made their accountants renumber by hand.
