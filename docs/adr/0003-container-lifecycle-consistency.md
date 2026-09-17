---
status: accepted
date: 2026-09-17
---

# Container lifecycle consistency

A Container is one physical object that two contexts care about differently. Registry needs to know where it serves and under which Agreement. Resources needs to know whether it is in a Warehouse, in service, in maintenance, or retired, and every movement in between. Modelling that as two Container aggregates, or as one row with an editable status field beside a movements table, produces the same failure: the two answers to "where is container 123" eventually disagree.

We decided on one stable Container identity with two context-owned records around it. Registry owns the Container Service Placement, effective-dated, naming the property or shared collection point, agreement, product, and waste fraction. Resources owns the append-only Stock Movement ledger. Container Asset State is a projection of that ledger and is never independently writable; no API writes it. Lifecycle transitions are single domain commands. "Issue container into service" writes the Stock Movement and the Container Service Placement in one transaction; return, transfer, and retire mirror it. Either both records change or neither does.

## Considered options

- Two Container aggregates sharing an id. Rejected: no owner of the invariant.
- An editable `asset_state` column. Rejected: the first manual edit turns the ledger into fiction.

## Consequences

- "Where is container 123" is answered from Asset State plus the current Service Placement, and the two cannot conflict.
- Every UI action that moves a container maps to exactly one command, not to two independent form saves.
