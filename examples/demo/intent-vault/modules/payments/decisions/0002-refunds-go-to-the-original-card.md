---
id: payments/0002
title: Refunds go back to the card that paid
status: accepted
date: 2026-05-01
module: payments
governs: [src/payments/refund.js]
provenance: human
review_date: 2099-01-01
supersedes: [payments/0001]
tags: [refunds]
---
# Refunds go back to the card that paid

## Context

Guests without accounts could not find their store credit, and support time cost more than the fee. The new provider refunds for free.

## Decision

Refunds go back to the original card. Store credit is no longer issued.

## Why — the intent

Mira, in the May review: "Credit that nobody can find is not a refund. Send the money back."

## Alternatives rejected

- Keep store credit and add accounts: conflicts with root/0001 (guest checkout only).

## Consequences

- `src/payments/refund.js` must never write store credit.
