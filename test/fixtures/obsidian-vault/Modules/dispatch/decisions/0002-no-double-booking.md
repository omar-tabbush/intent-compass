---
id: "0002"
status: superseded
date: 2025-04-15
module: dispatch
superseded-by: "[[Modules/dispatch/decisions/0004-soft-holds-instead-of-locks|0004]]"
---
# No double booking: lock the technician's slot

- Status: Accepted
- Date: 2025-04-15

## Decision

Booking a job takes a row lock on the technician's time slot until the office confirms.

## Why — the intent

Two dispatchers booked the same technician for the same hour twice in one week.

## Consequences / what an agent must NOT do

- Do not book a slot without the lock.
