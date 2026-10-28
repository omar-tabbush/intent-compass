# UTC everywhere

- Date: 2025-03-10
- Status: Accepted
- Module: [[dispatch]]
- Deciders: Teo Brandt, Mara Quill

## Context

Technicians work across two time zones near the state line. Jobs booked in one zone showed up an hour off on the other side.

## Decision

Store every timestamp as UTC. Convert to the branch's zone only when rendering, in `src/dispatch/format/time.ts`.

## Alternatives considered

- Store local time plus a zone name: every query would need the zone.
- Store the technician's zone: technicians move between branches.

## Consequences

- Never build a date from a local time string in dispatch code.
- The calendar export template writes `[[local-time]]` placeholders; that is not a wikilink.
