// The master data a service is described in (Issue #78): the waste fractions
// a company collects, the container types it owns, the cadences a project
// offers, and the Products a customer subscribes to. Everything here is a
// company's or a project's own vocabulary, not the code's: a fraction is a row
// because one company's "Plast/MDK" is another's "Hard plastic", where the
// kinds and statuses beside them are closed lists from
// @waste/domain/registry/vocabulary and the same in every company.
//
// `waste_fraction.key` is the stable slug the rest of the system quotes
// (`residual`, `food`, `paper`); the name is what a person reads and may be
// renamed without breaking anything. Both are unique per company, and the key
// is held lowercase so two rows cannot differ by case alone.
//
// `service_frequency` is the domain's `ServiceFrequencyDefinition` as a table,
// and `service_frequency_shape` is its rule: a null `collections_per_week` is
// on demand, and then neither interval may be given; `weeks_between` says once
// a week or less often, `days_between` more often than that, and never both.
// Monthly is `collections_per_week = 1` with neither interval, since a month
// is not a number of weeks.
//
// `product` is what an Agreement's Subscription names. Its container type,
// waste fraction and service frequency are all optional: a Product is a
// container collection, a recurring service or an additional service, and only
// the first has a container and a fraction. The frequency is the Product's
// default cadence, which a placement may override; the effective one is a
// `coalesce` on read, never copied (the Registry's rule from
// docs/architecture/backend-architecture.md).
//
// Prices are not here: a Price List and its rows are Finance & Contracting's,
// and a product's invoice name, code and VAT go with them.
import { PRODUCT_KINDS, PRODUCT_STATUSES, PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { lowercase, oneOf, positive } from "./checks"
import { id, projectScoped, tenant, timestamps } from "./columns"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantKey, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const wasteFraction = wms.table(
  "waste_fraction",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** The stable slug the rest of the system quotes: `residual`, `food`, `glass`. */
    key: text().notNull(),
    name: text().notNull(),
  },
  (t) => [companyReference(t, company), tenantUnique(t, t.key), tenantUnique(t, t.name), tenantKey(t), lowercase(t.key)],
)

export const containerType = wms.table(
  "container_type",
  {
    ...id,
    ...tenant,
    ...timestamps,
    name: text().notNull(),
    /** Null where nobody recorded one; zero is not a volume. */
    volumeLitres: integer(),
  },
  (t) => [companyReference(t, company), tenantUnique(t, t.name), tenantKey(t), positive(t.volumeLitres)],
)

export const serviceFrequency = wms.table(
  "service_frequency",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    description: text(),
    /** Null is on demand; 1 with neither interval is monthly. */
    collectionsPerWeek: integer(),
    /** Once a week or less often. */
    weeksBetween: integer(),
    /** More often than once a week. */
    daysBetween: integer(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    positive(t.collectionsPerWeek),
    positive(t.weeksBetween),
    positive(t.daysBetween),
    // The definition's own rule, which no helper spells because no other table
    // has it: an interval needs a rate to belong to, and the two intervals are
    // two ways of saying the same thing. The label the refusal prints names the
    // check itself, the way `company_self` does.
    check(
      tableObjectName(t.id.table, "shape", "serviceFrequency"),
      sql`(${t.collectionsPerWeek} is not null or (${t.weeksBetween} is null and ${t.daysBetween} is null)) and (${t.weeksBetween} is null or ${t.daysBetween} is null)`,
    ),
  ],
)

export const product = wms.table(
  "product",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    /** What one of it is: prices are Finance & Contracting's, the unit they are quoted per is here. */
    unit: text().notNull(),
    containerTypeId: uuid(),
    wasteFractionId: uuid(),
    /** The default cadence; a placement may override it, and the effective one is read, never written. */
    serviceFrequencyId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.containerTypeId], containerType),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    projectReference(t, [t.serviceFrequencyId], serviceFrequency),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.kind, PRODUCT_KINDS),
    oneOf(t.status, PRODUCT_STATUSES),
    oneOf(t.unit, PRODUCT_UNITS),
    tenantIndex(t, t.containerTypeId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.serviceFrequencyId),
  ],
)
