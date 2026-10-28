---
id: orders/0001
title: Prices are stored and computed in integer cents
status: accepted
date: 2026-01-15
module: orders
governs: [src/orders/pricing.js]
provenance: human
review_date: 2026-07-15
supersedes: []
tags: [money]
---
# Prices are stored and computed in integer cents

## Context

Early prototypes used floating point and a test order came out one cent short.

## Decision

All prices, totals and refunds are integer cents. Formatting to dollars happens only at the edge.

## Why — the intent

The owner, Mira, said: "A customer who is overcharged by a cent emails us. I never want to answer that email again."

## Alternatives rejected

- Decimal library: an extra dependency for a problem integers already solve.

## Consequences

- Never divide money without rounding rules agreed with Mira.
