---
id: "0004"
status: Design approved
date: 2025-08-11
module: dispatch
supersedes: ["0002"]
---
# Soft holds instead of slot locks

## Decision

A booking places a soft hold that expires after 10 minutes. No database locks.

## Why — the intent

Locks left behind by closed browser tabs blocked technicians for hours.
