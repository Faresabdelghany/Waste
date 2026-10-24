// The `project` table as an earlier migration left it, for the rendering
// tests that diff an applied file's ALTER TABLEs from one era's spelling to
// the next: 0005 bare, and 0006 with its working week (Issue #97) — today's,
// with the public slug too (Issue #293, migration 0017), is
// src/schema/organisation.ts itself. One spelling here, so
// planning-rendering.test.ts and sorting-guide-rendering.test.ts cannot drift
// on what an era said. Another table object of the same name is fine, since
// nothing connects to a database. Not a suite of its own: only ever imported.
import { sql } from "drizzle-orm"
import { check, text, type PgTable } from "drizzle-orm/pg-core"

import { DEFAULT_WEEKEND, SERVICE_DAYS } from "@waste/domain/planning/vocabulary"

import { tableObjectName } from "../names"
import { oneOf, subsetOf } from "../schema/checks"
import { id, tenant, timestamps } from "../schema/columns"
import { company, PROJECT_STATUSES } from "../schema/organisation"
import { companyReference, tenantKey, tenantUnique } from "../schema/references"
import { wms } from "../schema/wms"

/** The eras an applied file left the project in. */
type Era = "0005" | "0006"

export const projectAsOf = (asOf: Era): PgTable => (asOf === "0005" ? projectAsOf0005() : projectAsOf0006())

const projectAsOf0005 = () =>
  wms.table(
    "project",
    {
      ...id,
      ...tenant,
      ...timestamps,
      name: text().notNull(),
      kind: text().notNull(),
      language: text().notNull(),
      currency: text().notNull(),
      timezone: text().notNull(),
      status: text().notNull(),
    },
    (t) => [companyReference(t, company), tenantUnique(t, t.name), tenantKey(t), oneOf(t.status, PROJECT_STATUSES)],
  )

const projectAsOf0006 = () =>
  wms.table(
    "project",
    {
      ...id,
      ...tenant,
      ...timestamps,
      name: text().notNull(),
      kind: text().notNull(),
      language: text().notNull(),
      currency: text().notNull(),
      timezone: text().notNull(),
      status: text().notNull(),
      weekend: text()
        .array()
        .notNull()
        .default(sql.raw(`'{${DEFAULT_WEEKEND.join(",")}}'`)),
      holidayList: text(),
    },
    (t) => [
      companyReference(t, company),
      tenantUnique(t, t.name),
      tenantKey(t),
      oneOf(t.status, PROJECT_STATUSES),
      subsetOf(t.weekend, SERVICE_DAYS),
      check(tableObjectName(t.id.table, "weekend_not_every_day", "project"), sql`cardinality(${t.weekend}) < ${sql.raw(String(SERVICE_DAYS.length))}`),
    ],
  )
