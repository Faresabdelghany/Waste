// Routing (#39 S1, migration 0013, decided on #124 and #132): the Plan — one
// calculation over one dated Route — its sequence and its legs, the system's
// first stored line strings. Generation keeps writing the deterministic
// baseline into `pickup.position` and never calls the routing provider
// (ADR-0002); a Plan owns the execution sequence, and `route.active_plan_id`
// (execution.ts) says which one, ON DELETE SET NULL since it points back at
// its own child (reset-to-seed.ts, `parentsOf`).
//
// `plan` is current state with the run's-projection precedent
// (`generation_run`): the row may move from `calculating` to `ready` or
// `failed`, so it carries `timestamps` and the trigger. `plan_stop` and
// `plan_leg` are the immutable result (#124 §1): written exactly once — on
// creation for a known sequence, on `ready` for a solved one — append-only,
// so both spread `recorded` and their file carries the revoke, like every
// ledger. Deferral is `deferred_until` beside `calculating`, never a fourth
// status, and the one structured failure reason is `superseded` — every
// other reason is the provider's sentence, so the column has no closed list
// (#132 §4).
//
// `routing_quota` (#171, migration 0014) is what the quota engine knows of
// each request family — the provider's last reading and since when the
// family is exhausted or its key refused — written by the worker after every
// job that asked the provider and read by `GET /routing/quota` for the
// office's banner. The key is one account every company shares; the row is
// per company like every table (the tenant fence), so with the Pilot's one
// company it is one row per provider and family, and a second company on
// the same key is Gate B (#132 §1, ADR-0009).
import { PLAN_SOLVERS, PLAN_STATUSES, PLAN_TRIPS, ROUTING_QUOTA_FAMILIES } from "@waste/domain/routing/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf, positive } from "./checks"
import { id, projectScoped, recorded, tenant, timestamps } from "./columns"
import { pickup, route } from "./execution"
import { geometry, validGeometry } from "./geometry"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const plan = wms.table(
  "plan",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    /** Who ordered it: `optimiser`, `manual` or `baseline` (#124 §1). */
    solver: text().notNull(),
    /** Where the measurement stands; a `manual` or `baseline` Plan is active while `calculating`, dashed and unmeasured. */
    status: text().notNull().default("calculating"),
    /** The request-inputs key of idempotency, deduplication and the cache (#132 §6): the canonical string @waste/domain/routing/fingerprint spells. */
    fingerprint: text().notNull(),
    /** What was measured: the whole trip, or the stops alone when the Route names no depot or no station. */
    trip: text().notNull(),
    /** The totals, the sum of the legs; written with `ready` and never before. */
    distanceMetres: integer(),
    durationSeconds: integer(),
    /** When a quota-deferred job resumes (#132 §4): written on deferral, cleared when it runs, only ever beside `calculating`. */
    deferredUntil: timestamp({ withTimezone: true }),
    /** Why a `failed` Plan failed: the provider's sentence, or the structured `superseded`. */
    failureReason: text(),
    /** The provider that answered, and the response-side provenance #132 §6 keeps off the fingerprint. */
    provider: text().notNull(),
    engineVersion: text(),
    graphDate: date(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    // What route.active_plan_id, plan_stop and plan_leg point at: a plan of the route they name, and no other's.
    projectKey(t, t.routeId),
    oneOf(t.solver, PLAN_SOLVERS),
    oneOf(t.status, PLAN_STATUSES),
    oneOf(t.trip, PLAN_TRIPS),
    // Totals belong to `ready` alone, whole and non-negative there, absent otherwise.
    check(
      tableObjectName(t.id.table, "totals_shape", "plan"),
      sql`case ${t.status} when 'ready' then ${t.distanceMetres} is not null and ${t.distanceMetres} >= 0 and ${t.durationSeconds} is not null and ${t.durationSeconds} >= 0 else ${t.distanceMetres} is null and ${t.durationSeconds} is null end`,
    ),
    check(tableObjectName(t.id.table, "failure_shape", "plan"), sql`(${t.status} = 'failed') = (${t.failureReason} is not null)`),
    check(tableObjectName(t.id.table, "deferred_shape", "plan"), sql`${t.deferredUntil} is null or ${t.status} = 'calculating'`),
    // The cache lookup: a request whose fingerprint equals a ready Plan's consumes no call (#124 §4).
    tenantIndex(t, t.fingerprint),
  ],
)

export const planStop = wms.table(
  "plan_stop",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    planId: uuid().notNull(),
    pickupId: uuid().notNull(),
    /** The execution order the Plan holds, 1..n over the Route's pickups. */
    position: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    // Carries the route both ways: a stop names a plan of the route it names, and a pickup of that same route.
    projectReference(t, [t.routeId, t.planId], plan, [plan.routeId, plan.id]),
    projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
    tenantUnique(t, t.planId, t.position),
    tenantUnique(t, t.planId, t.pickupId),
    positive(t.position),
    // Nothing references the ledgers, so no key leads with the project; the sweep and any project read take this index, Execution's own practice.
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.pickupId),
  ],
)

export const planLeg = wms.table(
  "plan_leg",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    planId: uuid().notNull(),
    /** One leg per consecutive pair of the trip's points, 1..n in driving order. */
    position: integer().notNull(),
    /** The routed geometry, the system's first stored line string. */
    path: geometry.lineString().notNull(),
    metres: integer().notNull(),
    seconds: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.routeId, t.planId], plan, [plan.routeId, plan.id]),
    tenantUnique(t, t.planId, t.position),
    positive(t.position),
    validGeometry(t.path),
    // A leg of nothing is a leg of zero metres, never a negative one; the totals' shape holds the same on the plan.
    check(tableObjectName(t.id.table, "measure_shape", "planLeg"), sql`${t.metres} >= 0 and ${t.seconds} >= 0`),
    tenantIndex(t, t.projectId),
  ],
)

export const routingQuota = wms.table(
  "routing_quota",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** The provider the reading is of: `fake`, `openrouteservice`. */
    provider: text().notNull(),
    /** `directions` or `optimisation`: each family has its own daily quota (#132 §1). */
    family: text().notNull(),
    /** The provider's `x-ratelimit-remaining` and `x-ratelimit-limit`; null where it enforces none (the fake). */
    remaining: integer(),
    limit: integer(),
    /** When the provider's daily window resets. */
    resetAt: timestamp({ withTimezone: true }),
    /** Since when the day's quota is spent (a 403 with rate-limit headers); cleared by the next answer. */
    exhaustedAt: timestamp({ withTimezone: true }),
    /** Since when the provider refuses the key (a 401, or a 403 without the headers); cleared by the next answer. */
    keyRefusedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    companyReference(t, company),
    tenantUnique(t, t.provider, t.family),
    oneOf(t.family, ROUTING_QUOTA_FAMILIES),
    check(tableObjectName(t.id.table, "counts_shape", "routingQuota"), sql`(${t.remaining} is null or ${t.remaining} >= 0) and (${t.limit} is null or ${t.limit} >= 0)`),
  ],
)
