// The organisation half of Organisation & Access (Issue #70): the tenant
// itself, its Projects, and the Service Providers it works with. The tables
// `company_id` and `project_id` have pointed at since the foundation. Statuses
// are text with a check (checks.ts), not an enum; the contracts' zod enum is
// the vocabulary. None of this is effective-dated (ADR-0005): a Company, a
// Project and a Service Provider carry a status, and the relationship dates
// of a provider belong to its Service Areas (Finance & Contracting).
//
// `company` is its own tenant: `company_id = id` (the `company_self` check, and
// no foreign key to itself), so the fence applies to it like to every other
// table and a transaction set to a company sees exactly its own row. A Company
// is created by the seed or an operator, never through a tenant's request.
//
// The Service Provider record is the external organisation (legal name,
// registration, country, contact), placed beside Company because a Service
// Provider Access grants for it; what it is assigned to is Finance &
// Contracting's.
//
// A Project carries its working week (Issue #97): `weekend` is the set of
// days it rests on, held to the seven by `subsetOf` and to fewer than all of
// them by `project_weekend_not_every_day` — a project has a working day, or a
// holiday policy shifting a collection to the next one would walk off the
// calendar — and never derived from a weekday number, since Cairo rests
// Friday–Saturday; its default is the domain's `DEFAULT_WEEKEND`, the same
// constant the contracts default from, spelled into the column as an array
// literal. `holiday_list` is the name of the list its holidays are looked up
// under, and null is "no list" — a project without one rests on its weekend
// only, whatever calendars it has (CONTEXT.md). Both arrived with migration
// 0006, the first `ALTER TABLE` to a table already applied.
//
// A Company carries the route-number counter (Issue #104): `next_route_number`,
// the next `RC-<n>` it mints, per company and not per project since a person
// reads "route 1042" across the company (#104 §7.17). Generation takes a
// block in one statement, `update company set next_route_number =
// next_route_number + N where id = ? returning next_route_number`, whose row
// lock is the serialisation, so two runs never share a number and no route
// is ever renumbered; the prototype hashed the identity and tolerated
// collisions. It arrived with migration 0008, the first `ALTER TABLE company`.
import { DEFAULT_WEEKEND, SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf, subsetOf } from "./checks"
import { id, tenant, timestamps } from "./columns"
import { companyReference, tenantKey, tenantUnique, uniqueOn } from "./references"
import { wms } from "./wms"

/** A company's status: onboarding until its first project runs. */
export const COMPANY_STATUSES = ["active", "onboarding"] as const
/** A project's status: onboarding until it runs. */
export const PROJECT_STATUSES = ["active", "onboarding"] as const

export const company = wms.table(
  "company",
  {
    ...id,
    ...tenant,
    ...timestamps,
    name: text().notNull(),
    legalName: text().notNull(),
    /** As the company registry spells it (a CVR number in Denmark). */
    registrationNumber: text().notNull(),
    /** ISO 3166-1 alpha-2. */
    country: text().notNull(),
    status: text().notNull(),
    /** The route-number counter (Issue #104): the next `RC-<n>` this company mints. Generation allocates a block in one `update … returning`, whose row lock is the serialisation; the default keeps a demo number from reading as a count. */
    nextRouteNumber: integer().notNull().default(1000),
  },
  (t) => [
    // The registration is the one identity a registry gives a company: once per country.
    uniqueOn(t.country, t.registrationNumber),
    // The company is its own tenant. There is no helper for a check this
    // table alone needs, so the label the refusal would print names the check
    // itself, the way every other call here names the helper that built it.
    check(tableObjectName(t.id.table, "self", "companySelf"), sql`${t.companyId} = ${t.id}`),
    oneOf(t.status, COMPANY_STATUSES),
  ],
)

export const project = wms.table(
  "project",
  {
    ...id,
    ...tenant,
    ...timestamps,
    name: text().notNull(),
    /** Free text: Municipality, Business unit, Contract, Region. */
    kind: text().notNull(),
    /** BCP 47 (`da`). */
    language: text().notNull(),
    /** ISO 4217 (`DKK`). */
    currency: text().notNull(),
    /** IANA (`Europe/Copenhagen`). */
    timezone: text().notNull(),
    status: text().notNull(),
    /** The days the project rests on; the domain's default (Saturday and Sunday) unless it says otherwise, and never all seven. */
    weekend: text()
      .array()
      .notNull()
      .default(sql.raw(`'{${DEFAULT_WEEKEND.join(",")}}'`)),
    /** The name of the holiday list its holidays are looked up under (`Danish public holidays`); null is no list, and then the project rests on its weekend only. */
    holidayList: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantUnique(t, t.name),
    tenantKey(t),
    oneOf(t.status, PROJECT_STATUSES),
    subsetOf(t.weekend, SERVICE_DAYS),
    // A weekend leaves a working day: `subsetOf` holds the days to the seven,
    // this holds them to fewer than all seven. No helper spells it because no
    // other table has it; the label names the check itself.
    check(tableObjectName(t.id.table, "weekend_not_every_day", "project"), sql`cardinality(${t.weekend}) < ${sql.raw(String(SERVICE_DAYS.length))}`),
  ],
)

export const serviceProvider = wms.table(
  "service_provider",
  {
    ...id,
    ...tenant,
    ...timestamps,
    legalName: text().notNull(),
    registrationNumber: text().notNull(),
    /** ISO 3166-1 alpha-2. */
    country: text().notNull(),
    contactName: text().notNull(),
    contactEmail: text().notNull(),
  },
  (t) => [companyReference(t, company), tenantUnique(t, t.country, t.registrationNumber), tenantKey(t)],
)
