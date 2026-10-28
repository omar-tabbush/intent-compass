---
id: "0003"
status: accepted
date: 2025-06-20
module: dispatch
supersedes: ["0001"]
tags: [assignment]
---
# Weighted assignment: distance, skills and fairness

## Decision

Score each free technician by distance, matching skills and jobs already done today. The highest score wins.

## Why — the intent

Nearest-free sent the same two technicians every emergency job and they burned out. Teo: "Fairness is a requirement, not a nice-to-have."

## What we rejected and why

- Round robin: ignores skills and sends a plumber to a wiring job.

## Consequences / what an agent must NOT do

- Do not drop the fairness term from the score in `src/dispatch/score.ts`.
