---
status: accepted
date: 2026-09-17
---

# Offline execution

A driver starts a Route with connectivity, loses it for hours, and must still record arriving at a stop, the Pickup, weight, exceptions, photos, Proof of Service, and Unloads at an Unloading Station. The glossary already says a Session tracks queued actions. This is a day-one property of the Execution context, not a mobile feature added later.

We decided that the driver app is Expo with PowerSync, and that the server is authoritative. Every driver action is a command with a client-generated UUIDv7, an idempotency key, the device timestamp, and the server receipt timestamp. Commands upload in order through PowerSync's queue and are applied by the API against current state; a command the server rejects is kept, raises a Ticket for resolution, and is never silently dropped. Photos queue as attachments to Supabase Storage in the same order. A Plan activated on the Route while a Session is active is not pushed onto the device; the driver's frozen sequence stands until they accept the change online (see ADR-0002).

## Considered options

- Zero (Rocicorp). Rejected: rejects offline writes by design.
- Replicache. Rejected: maintenance mode.
- ElectricSQL. Rejected: read-path only since its rewrite.
- A hand-built Expo SQLite outbox. Kept as the fallback if PowerSync's licence or hosting becomes a problem; the command discipline above is identical either way.

## Consequences

- PowerSync's service is source-available under FSL, not open source. It is self-hosted or run in an EU region, and requires logical replication on the Supabase project.
- Every Execution table a driver can write to needs client-generated ids and idempotent handlers from the first migration.
