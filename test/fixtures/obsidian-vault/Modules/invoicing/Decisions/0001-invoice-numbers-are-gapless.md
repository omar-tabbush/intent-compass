# Invoice numbers are one gapless sequence

- Date: 2025-05-06
- Status: superseded by [[Modules/invoicing/Decisions/0003-per-branch-invoice-sequences|0003]]
- Module: [[invoicing]]

## Context

Some tenants are legally required to issue invoice numbers without gaps.

## Decision

One gapless sequence of invoice numbers per tenant.

## Alternatives considered

- Random invoice IDs: not allowed for those tenants.

## Consequences

- Never delete an invoice; void it instead.
