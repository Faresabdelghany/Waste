// The `project` table as an earlier migration left it, for the rendering
// tests that diff an applied file's ALTER TABLEs from one era's spelling to
// the next: 0005 bare, 0006 with its working week (Issue #97), and 0017 with
// the public slug too (Issue #293), and 0037 with the payment terms and the
// reference scheme too (#291 C4) — today's, with the weighbridge's tolerance
// (O9 of #290, migration 0045), is src/schema/organisation.ts itself. One
// spelling here, so planning-rendering.test.ts, sorting-guide-rendering.test.ts
// and weighbridge-rendering.test.ts cannot drift on what an era said. Another table object of the same name is fine, since
// nothing connects to a database. Not a suite of its own: only ever imported.
import { sql } from "drizzle-orm"
import { check, integer, text, type PgTable } from "drizzle-orm/pg-core"

import { PUBLIC_SLUG_LENGTH, PUBLIC_SLUG_PATTERN } from "@waste/domain/access/public-slug"
import { DEFAULT_PAYMENT_TERMS_DAYS, PAYMENT_TERMS_MAX } from "@waste/domain/finance/payment"
import { PAYMENT_REFERENCE_SCHEMES } from "@waste/domain/finance/vocabulary"
import { DEFAULT_WEEKEND, SERVICE_DAYS } from "@waste/domain/planning/vocabulary"

import { tableObjectName } from "../names"
import { oneOf, subsetOf } from "../schema/checks"
import { id, tenant, timestamps } from "../schema/columns"
import { company, PROJECT_STATUSES } from "../schema/organisation"
import { companyReference, tenantKey, tenantUnique, uniqueOn } from "../schema/references"
import { wms } from "../schema/wms"

/** The eras an applied file left the project in. */
type Era = "0005" | "0006" | "0017" | "0037"

export const projectAsOf = (asOf: Era): PgTable => (asOf === "0005" ? projectAsOf0005() : asOf === "0006" ? projectAsOf0006() : asOf === "0017" ? projectAsOf0017() : projectAsOf0037())

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

const projectAsOf0017 = () =>
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
      publicSlug: text(),
    },
    (t) => [
      companyReference(t, company),
      tenantUnique(t, t.name),
      tenantKey(t),
      oneOf(t.status, PROJECT_STATUSES),
      subsetOf(t.weekend, SERVICE_DAYS),
      check(tableObjectName(t.id.table, "weekend_not_every_day", "project"), sql`cardinality(${t.weekend}) < ${sql.raw(String(SERVICE_DAYS.length))}`),
      uniqueOn(t.publicSlug),
      check(
        tableObjectName(t.id.table, "public_slug_shape", "project"),
        sql`${t.publicSlug} ~ ${sql.raw(`'${PUBLIC_SLUG_PATTERN}'`)} and char_length(${t.publicSlug}) between ${sql.raw(String(PUBLIC_SLUG_LENGTH.min))} and ${sql.raw(String(PUBLIC_SLUG_LENGTH.max))}`,
      ),
    ],
  )

const projectAsOf0037 = () =>
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
      publicSlug: text(),
      paymentTermsDays: integer().notNull().default(DEFAULT_PAYMENT_TERMS_DAYS),
      paymentReferenceScheme: text().notNull().default("none"),
    },
    (t) => [
      companyReference(t, company),
      tenantUnique(t, t.name),
      tenantKey(t),
      oneOf(t.status, PROJECT_STATUSES),
      subsetOf(t.weekend, SERVICE_DAYS),
      check(tableObjectName(t.id.table, "weekend_not_every_day", "project"), sql`cardinality(${t.weekend}) < ${sql.raw(String(SERVICE_DAYS.length))}`),
      uniqueOn(t.publicSlug),
      oneOf(t.paymentReferenceScheme, PAYMENT_REFERENCE_SCHEMES),
      check(tableObjectName(t.id.table, "payment_terms_range", "project"), sql`${t.paymentTermsDays} between 0 and ${sql.raw(String(PAYMENT_TERMS_MAX))}`),
      check(
        tableObjectName(t.id.table, "public_slug_shape", "project"),
        sql`${t.publicSlug} ~ ${sql.raw(`'${PUBLIC_SLUG_PATTERN}'`)} and char_length(${t.publicSlug}) between ${sql.raw(String(PUBLIC_SLUG_LENGTH.min))} and ${sql.raw(String(PUBLIC_SLUG_LENGTH.max))}`,
      ),
    ],
  )
