# Short-lived session tokens

- Date: 2025-05-01
- Status: Accepted
- Module: [[auth]]

## Context

Tablets in the vans are shared between technicians on different shifts.

## Decision

Session tokens expire after 8 hours. Refresh tokens are not issued to tablets.

## Alternatives considered

- 30-day sessions: one lost tablet would expose a month of jobs.

## Consequences

- Do not add a "remember me" box to the tablet login. The `[[session]]` helper in our notes is not a module.
- Related: [[0002-passwordless-for-technicians]].
