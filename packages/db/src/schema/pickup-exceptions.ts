// Pickup Exceptions (Issue #293, M5a): a company's contaminant codes, and a
// project's rules for charging a Pickup whose outcome the customer caused
// (@waste/domain/execution/pickup-exceptions says which stops those are and
// how a rule judges one).
//
// `contaminant_code` is master data like a waste fraction: the company's own
// names for the wrong waste in a bin (`plastic-in-organic`), its `code`
// lowercase and unique, retired by status rather than deleted, since a stop
// names the code it was tagged with (`pickup.contaminant_code_id`, schema/
// execution.ts). `contaminant_code_fraction` narrows a code to the fractions
// it applies to; a code with none applies to every fraction.
//
// `pickup_exception_rule` is effective-dated (ADR-0005) per project: the
// outcome it governs, the reason and the code it narrows to (null for any),
// how many matching exceptions in its window cost nothing, and the window.
// Two rules alike — the same outcome, reason and code — are never in force at
// once (`pickup_exception_rule_no_overlap`, hand-written in the migration),
// which needs a NOT NULL key: `match_key` folds the nullable two into one
// value the exclusion constraint can key on, as `price_list_row.condition_key`
// does. A tagged collection's rule names no reason; a code goes with the
// reason `contamination`, with any reason, or with a tagged collection.
//
// `pickup_exception_rule_step` is a rule's ladder: the product charged at each
// charged occurrence, by position from 1, the last repeating. A step's product
// is the rule's project's — an additional service sold per job, which the API
// holds it to — priced by the Price Engine on the stop's service date like any
// other; this slice charges nothing yet (M5b).
import { CONTAMINANT_CODE_STATUSES, PICKUP_EXCEPTION_REASONS, PICKUP_OUTCOMES } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, unique, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { lowercase, oneOf, positive } from "./checks"
import { id, projectScoped, tenant, timestamps, validity, validPeriod } from "./columns"
import { product, wasteFraction } from "./catalogue"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantKey, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const contaminantCode = wms.table(
  "contaminant_code",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** The stable slug a report and an integration quote: `plastic-in-organic`. */
    code: text().notNull(),
    name: text().notNull(),
    status: text().notNull().default("active"),
  },
  (t) => [companyReference(t, company), tenantUnique(t, t.code), tenantUnique(t, t.name), tenantKey(t), lowercase(t.code), oneOf(t.status, CONTAMINANT_CODE_STATUSES)],
)

export const contaminantCodeFraction = wms.table(
  "contaminant_code_fraction",
  {
    ...id,
    ...tenant,
    ...timestamps,
    contaminantCodeId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.contaminantCodeId], contaminantCode),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // One row per fraction a code applies to; the derived name would pass 63 bytes, so the key is named for what it holds.
    unique(tableObjectName(t.companyId.table, "membership_key", "contaminantCodeFraction")).on(t.companyId, t.contaminantCodeId, t.wasteFractionId),
    tenantIndex(t, t.wasteFractionId),
  ],
)

export const pickupExceptionRule = wms.table(
  "pickup_exception_rule",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** The outcome governed: `failed`, `skipped`, or `completed` for a tagged collection. */
    outcome: text().notNull(),
    /** The reason narrowed to; null for any of the customer's reasons, and always null on a tagged collection's rule. */
    reason: text(),
    /** The code narrowed to; null for any code, or none. */
    contaminantCodeId: uuid(),
    /** How many matching exceptions in the window cost nothing: 0 charges the first. */
    freeCount: integer().notNull(),
    /** The days before a stop's service date its earlier exceptions are counted over. */
    windowDays: integer().notNull(),
    /** The outcome, reason and code as one NOT NULL value the exclusion constraint can key on. Never on the wire. */
    matchKey: text()
      .notNull()
      .generatedAlwaysAs(sql`"outcome" || '/' || coalesce("reason", '*') || '/' || coalesce("contaminant_code_id"::text, '*')`),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.contaminantCodeId], contaminantCode),
    projectKey(t),
    validPeriod(t),
    oneOf(t.outcome, PICKUP_OUTCOMES),
    oneOf(t.reason, PICKUP_EXCEPTION_REASONS),
    // A tagged collection has no reason; a code tags the wrong waste, so it narrows contamination, any reason, or a tagged collection.
    check(tableObjectName(t.id.table, "reason_shape", "pickupExceptionRule"), sql`${t.outcome} <> 'completed' or ${t.reason} is null`),
    check(tableObjectName(t.id.table, "code_shape", "pickupExceptionRule"), sql`${t.contaminantCodeId} is null or ${t.reason} is null or ${t.reason} = 'contamination'`),
    check(tableObjectName(t.id.table, "free_count_not_negative", "pickupExceptionRule"), sql`${t.freeCount} >= 0`),
    check(tableObjectName(t.id.table, "window_days_range", "pickupExceptionRule"), sql`${t.windowDays} between 1 and 3660`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.contaminantCodeId),
  ],
)

export const pickupExceptionRuleStep = wms.table(
  "pickup_exception_rule_step",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ruleId: uuid().notNull(),
    /** The charged occurrence this step prices, from 1; the last repeats. */
    position: integer().notNull(),
    productId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.ruleId], pickupExceptionRule),
    projectReference(t, [t.productId], product),
    projectKey(t),
    positive(t.position),
    unique(tableObjectName(t.companyId.table, "rule_position_key", "pickupExceptionRuleStep")).on(t.companyId, t.ruleId, t.position),
    tenantIndex(t, t.productId),
  ],
)
