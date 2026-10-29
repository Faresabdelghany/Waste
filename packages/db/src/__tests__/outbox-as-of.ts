// `outbox_event` as 0010 (Issue #112) left it and 0033 still had it: the
// outbox's vocabulary as Execution's, Resolution's and Finance's news, before
// the Registry's decided application (M7 of #293); and as 0040 left it, before
// the recycling-centre visits' two kinds about a `site-visit` (#393, migration
// 0054); and as 0054 left it, before the staff notifications' `alert-raised` and
// `ticket-assigned` and their `alert` (O16 of #290); and as 0075 left it,
// before the booking notices' two kinds about a `bulky-booking` (O16, part b).
// finance-rendering.test.ts
// diffs to 0010's, applications-rendering.test.ts from 0010's to 0040's,
// site-visits-rendering.test.ts from 0040's to 0054's and
// staff-notifications-rendering.test.ts from 0054's to 0075's and
// booking-notices-rendering.test.ts from 0075's to 0076's, before the
// service notifications' `ticket-replied` (C18 of #291), and
// service-notifications-rendering.test.ts from 0076's, since an applied file is
// never edited and the schema module spells the table as it is today.
import { OUTBOX_AGGREGATES, OUTBOX_KINDS } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { oneOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { company, project } from "../schema/organisation"
import { companyReference, indexOn, tenantIndex, tenantReference } from "../schema/references"
import { wms } from "../schema/wms"

/** The outbox's vocabulary as of 0076: everything until the service notifications' reply (C18 of #291), which no aggregate of its own carries. */
export const OUTBOX_KINDS_AS_OF_0076 = OUTBOX_KINDS.filter((kind) => kind !== "ticket-replied")
export const OUTBOX_AGGREGATES_AS_OF_0076 = OUTBOX_AGGREGATES

/** The outbox's vocabulary as of 0075: everything until the booking notices' kinds and aggregate (O16 of #290, part b). */
export const OUTBOX_KINDS_AS_OF_0075 = OUTBOX_KINDS_AS_OF_0076.filter((kind) => kind !== "bulky-booking-booked" && kind !== "bulky-booking-cancelled")
export const OUTBOX_AGGREGATES_AS_OF_0075 = OUTBOX_AGGREGATES_AS_OF_0076.filter((aggregate) => aggregate !== "bulky-booking")

/** The outbox's vocabulary as of 0054: everything until the staff notifications' kinds and aggregate (O16 of #290). */
export const OUTBOX_KINDS_AS_OF_0054 = OUTBOX_KINDS_AS_OF_0075.filter((kind) => kind !== "alert-raised" && kind !== "ticket-assigned")
export const OUTBOX_AGGREGATES_AS_OF_0054 = OUTBOX_AGGREGATES_AS_OF_0075.filter((aggregate) => aggregate !== "alert")

/** The outbox's vocabulary as of 0040: everything until the visits' kinds and aggregate (#393). */
export const OUTBOX_KINDS_AS_OF_0040 = OUTBOX_KINDS_AS_OF_0054.filter((kind) => kind !== "site-visit-recorded" && kind !== "site-visit-voided")
export const OUTBOX_AGGREGATES_AS_OF_0040 = OUTBOX_AGGREGATES_AS_OF_0054.filter((aggregate) => aggregate !== "site-visit")

/** The outbox's vocabulary as of 0010: everything until the Registry's kind and aggregate. */
export const OUTBOX_KINDS_AS_OF_0010 = OUTBOX_KINDS_AS_OF_0040.filter((kind) => kind !== "application-decided")
export const OUTBOX_AGGREGATES_AS_OF_0010 = OUTBOX_AGGREGATES_AS_OF_0040.filter((aggregate) => aggregate !== "application")

/** The outbox table as 0010, 0040, 0054, 0075 or 0076 left it: the same columns, keys and indexes as src/schema/execution.ts, the two checks over the earlier lists. */
const outboxEventAsOf = (kinds: readonly string[], aggregates: readonly string[]) =>
  wms.table(
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
    oneOf(t.kind, kinds),
    oneOf(t.aggregateKind, aggregates),
    indexOn(t.id).where(sql`${t.publishedAt} is null`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.aggregateId),
  ],
)

export const outboxEventAsOf0010 = outboxEventAsOf(OUTBOX_KINDS_AS_OF_0010, OUTBOX_AGGREGATES_AS_OF_0010)
export const outboxEventAsOf0040 = outboxEventAsOf(OUTBOX_KINDS_AS_OF_0040, OUTBOX_AGGREGATES_AS_OF_0040)
export const outboxEventAsOf0054 = outboxEventAsOf(OUTBOX_KINDS_AS_OF_0054, OUTBOX_AGGREGATES_AS_OF_0054)
export const outboxEventAsOf0075 = outboxEventAsOf(OUTBOX_KINDS_AS_OF_0075, OUTBOX_AGGREGATES_AS_OF_0075)
export const outboxEventAsOf0076 = outboxEventAsOf(OUTBOX_KINDS_AS_OF_0076, OUTBOX_AGGREGATES_AS_OF_0076)
