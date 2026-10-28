# Tidepool

Decision log for Tidepool, the field-service scheduling app.

## Modules

- [[Modules/dispatch/dispatch|dispatch]]: assigning jobs to technicians
- [[Modules/invoicing/invoicing|invoicing]]: invoices and tax
- [[Modules/auth|auth]]: sign-in for office staff and technicians

## Cross-cutting

- [[decisions/0001-one-postgres-database|0001]] One Postgres database
- [[decisions/0002-utc-everywhere|0002]] UTC everywhere
- [[decisions/0004-reporting-read-replica|0004]] Reporting read replica
- [[decisions/0019-feature-flags-live-in-config|0019]] Feature flags in config
- [[decisions/0019-sms-retry-budget|0019]] SMS retry budget
- [[decisions/0020-flag-service-for-tenant-rollouts|0020]] Flag service
- [[decisions/0048-money-as-integer-cents|0048]] Money as integer cents

Last distil: [[daily/2026-10-01]].
