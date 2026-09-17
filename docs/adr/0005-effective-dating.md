---
status: accepted
date: 2026-09-17
---

# Effective dating and temporal integrity

Agreement, Subscription, Container Service Placement, Route Scheme, Price List, Service Area, Service Area Assignment, Vehicle Allocation, and Planning Area versions are all effective-dated in the glossary. Generation, billing, and authorisation each ask "which of these was valid on that date". Getting this wrong is the hardest schema mistake to retrofit.

We decided that every effective-dated table uses `valid_from` and a nullable `valid_to`, half-open, where a null `valid_to` means open-ended. A `btree_gist` exclusion constraint per business key forbids overlapping periods in the database, not in application code. Validity is evaluated at query time against the service date or the request date and is never stored as a flag. We do not model a second, recorded-at time dimension: the history of edits is the audit log, not the domain model.

## Considered options

- Version rows with an `is_current` flag. Rejected: overlaps go unenforced and "valid on a past date" needs application logic.
- Bitemporal tables. Rejected: the cost is not justified until a regulator asks "what did you believe on that date".

## Consequences

- The `btree_gist` extension is required.
- Every query over these tables takes an as-of date. Generation asks which Service Placement was valid on the service date, not which is valid today.
