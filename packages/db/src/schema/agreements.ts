// What a Customer is entitled to, and until when (Issue #78). These are the
// first effective-dated tables of the system (ADR-0005): both spread
// `validity`, carry `validPeriod`, and have one `excludeOverlapping`
// constraint in the migration, so the database itself refuses two of the same
// thing at once.
//
// `agreement.number` is the number a person quotes (`AGR-2408`), and it is
// deliberately **not** unique per company: one agreement of that number may be
// valid at a time, which the exclusion constraint says and a unique constraint
// could not, so a number may name a later agreement once the earlier one has
// ended. An amendment changes the row (the audit log is the history);
// termination is `valid_to`; "pending", "expiring", "expired" and "terminated"
// are readings of the period and never columns. `payer_customer_id` is the
// same Customer as `customer_id` in the common case and a housing
// administrator in the interesting one. `price_list_id` (Issue #112,
// migration 0010) is the Price List the agreement is priced under, a list of
// the project in the agreement's currency, which the Registry's own patch
// takes; null is the project's default list, and an agreement reaching
// neither blocks its events with `no-price-list`.
//
// `subscription` is one Product delivered at one place under one Agreement.
// The place is a Property or a Shared Collection Point, exactly one of the two
// (`subscription_location_exactly_one`), and `location_id` is the generated
// column that makes it one NOT NULL value: an exclusion constraint's key
// column may not be nullable, since a null never equals anything and rows with
// one would overlap freely, so `coalesce(property_id,
// shared_collection_point_id)` is stored and the key
// `(agreement, product, location)` holds. It is the database's device and
// never on the wire.
//
// A subscription's period lies inside its agreement's, and a placement's
// inside its subscription's; Postgres cannot say that across rows without a
// trigger, so the API refuses it and a query for "subscribed on day D" joins
// the agreement's validity too.
import { AGREEMENT_STATUSES, BILLING_CADENCES } from "@waste/domain/registry/vocabulary"
import { sql } from "drizzle-orm"
import { integer, text, uuid } from "drizzle-orm/pg-core"

import { exactlyOne, oneOf, positive } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { product } from "./catalogue"
import { customer, property, sharedCollectionPoint } from "./customers"
// Finance's list (Issue #112) is what an agreement is priced under. finance.ts
// imports this module back for the agreement a billable event runs under; the
// cycle is safe because every reference is read inside a table's extra-config
// callback, which drizzle runs after both modules have loaded, never at the
// top level.
import { priceList } from "./finance"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

export const agreement = wms.table(
  "agreement",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** The number a person quotes: `AGR-2408`. Unique among the agreements valid at one time, which the exclusion constraint holds. */
    number: text().notNull(),
    customerId: uuid().notNull(),
    /** Who is invoiced; the same Customer as `customer_id` in the common case. */
    payerCustomerId: uuid().notNull(),
    status: text().notNull(),
    billingCadence: text().notNull(),
    /** ISO 4217 (`DKK`); the form defaults it to the project's. */
    currency: text().notNull(),
    /** Internal, never the portal's. */
    notes: text(),
    /** The Price List the agreement is priced under (Issue #112), in the agreement's currency; null is the project's default list. */
    priceListId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.customerId], customer),
    tenantReference(t, [t.payerCustomerId], customer),
    projectReference(t, [t.priceListId], priceList),
    projectKey(t),
    validPeriod(t),
    oneOf(t.status, AGREEMENT_STATUSES),
    oneOf(t.billingCadence, BILLING_CADENCES),
    // The number is looked up by hand and is not a unique constraint, so it needs an index of its own.
    tenantIndex(t, t.number),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.payerCustomerId),
    tenantIndex(t, t.priceListId),
  ],
)

export const subscription = wms.table(
  "subscription",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    agreementId: uuid().notNull(),
    productId: uuid().notNull(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    /** Whichever place is set, as one NOT NULL value the exclusion constraint can key on. Never on the wire. */
    locationId: uuid()
      .notNull()
      .generatedAlwaysAs(sql`coalesce("property_id", "shared_collection_point_id")`),
    quantity: integer().notNull().default(1),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.agreementId], agreement),
    projectReference(t, [t.productId], product),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    projectKey(t),
    validPeriod(t),
    exactlyOne(t, "location", [t.propertyId, t.sharedCollectionPointId]),
    positive(t.quantity),
    tenantIndex(t, t.productId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
  ],
)
