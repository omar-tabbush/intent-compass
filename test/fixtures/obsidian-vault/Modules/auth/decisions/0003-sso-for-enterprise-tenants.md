---
id: "0003"
status: accepted
date: 2026-03-15
supersedes: ["0002"]
relates: ["[[0001-short-lived-session-tokens]]"]
tags: [login, sso]
---
# Enterprise tenants sign in through their own SSO

## Decision

Tenants on the enterprise plan sign in through their identity provider, technicians included.

## Why — the intent

Enterprise tenants must remove access the same day a technician leaves. One-time codes sent to personal phones could not guarantee that.
