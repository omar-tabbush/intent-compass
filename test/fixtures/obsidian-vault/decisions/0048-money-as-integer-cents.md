---
id: "0048"
status: accepted
date: 2026-02-09
module: "[[invoicing]]"
review_date: 2026-08-01
tags: [money, invoicing]
---
# Money is stored as integer cents

## Decision

Every amount is an integer number of cents with a currency code. See `src/invoicing/money.ts`.

## Why — the intent

Rounding errors on split invoices cost a tenant one cent per line and their accountant noticed. Ines: "Integers or nothing."

## What we rejected and why

- Decimal columns: the client code still turned them into floats.

## Consequences / what an agent must NOT do

- Never use floats for money, not in tests either. This is how the bug started:

```ts
const total = 0.1 + 0.2; // [[float-money]] is not a note
```
