---
id: "0004"
status: superseded
date: 2025-05-20
module: invoicing
superseded-by: ../../../decisions/0048-money-as-integer-cents
---
# Amounts are decimal columns

## Decision

Invoice amounts use `numeric(12,2)` columns.

## Why — the intent

Decimal columns looked like the safe default.
