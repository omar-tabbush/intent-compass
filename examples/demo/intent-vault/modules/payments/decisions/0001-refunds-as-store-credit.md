---
id: payments/0001
title: Refunds are issued as store credit
status: accepted
date: 2026-02-01
module: payments
governs: [src/payments/refund.js]
provenance: human
review_date: 2026-08-01
supersedes: []
tags: [refunds]
---
# Refunds are issued as store credit

## Context

The first payment provider charged a fee on every card refund.

## Decision

Refunds become store credit on the guest's email.

## Why — the intent

Mira wanted to keep the refund fee out of a low-margin business.

## Alternatives rejected

- Card refunds: a fee per refund.

## Consequences

- Guests need the same email to spend credit.
