// `outbox_event` as 0010 (Issue #112) left it and 0033 still had it: the
// outbox's vocabulary as Execution's, Resolution's and Finance's news, before
// the Registry's decided application (M7 of #293). finance-rendering.test.ts
// diffs to it and applications-rendering.test.ts from it, since an applied
// file is never edited and the schema module spells the table as it is today.
import { OUTBOX_AGGREGATES, OUTBOX_KINDS } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { oneOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { company, project } from "../schema/organisation"
import { companyReference, indexOn, tenantIndex, tenantReference } from "../schema/references"
import { wms } from "../schema/wms"

/** The outbox's vocabulary as of 0010: everything until the Registry's kind and aggregate. */
export const OUTBOX_KINDS_AS_OF_0010 = OUTBOX_KINDS.filter((kind) => kind !== "application-decided")
export const OUTBOX_AGGREGATES_AS_OF_0010 = OUTBOX_AGGREGATES.filter((aggregate) => aggregate !== "application")

/** The outbox table as 0010 left it: the same columns, keys and indexes as src/schema/execution.ts, the two checks over the earlier lists. */
export const outboxEventAsOf0010 = wms.table(
  "outbox_event",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    kind: text().notNull(),
    aggregateKind: text().notNull(),
    aggregateId: uuid().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    payload: jsonb().notNull(),
    publishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    oneOf(t.kind, OUTBOX_KINDS_AS_OF_0010),
    oneOf(t.aggregateKind, OUTBOX_AGGREGATES_AS_OF_0010),
    indexOn(t.id).where(sql`${t.publishedAt} is null`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.aggregateId),
  ],
)
