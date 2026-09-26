// Generation's own two tables (Issue #97 part B, ADR-0002): the record of
// one run of the job that turns a Route Scheme's rules into dated Routes and
// Pickups, and the drift stamp of #41 beside it. Both are a Project's, both
// fenced and triggered, and neither is a ledger: a run's row moves from
// `queued` through `running` to `succeeded` or `failed` and carries its
// counts, and a stamp is an ordinary row an ordinary query reads two of.
//
// `generation_run` is one run over one scheme and one window: what started
// it (`trigger`, the office's button or the nightly cron), the window it was
// asked for (`window_from` to `window_to`, both inclusive, `window_to` on or
// after `window_from` under `generation_run_window_ordered`; the job itself
// walks at most `WALK_CAP_DAYS` past the start and says so), where it stands,
// pg-boss's job id where a job carried it, the two instants the status moved,
// and what it did — routes created, refreshed and cancelled, pickups written,
// holidays skipped, and `unlocated`, the containers it could not place on a
// service date: a matched container whose place has no location, or a picked
// one with no placement valid that day. `warnings` are the sentences the run
// wants read beside its counts — a day with no boundary in force, a scheme
// with no planning area and a rule group — never a throw. `error` is the
// `loggable` projection of what failed and never a statement or its
// parameters. It carries `projectKey`, since a route names the run that last
// wrote it (`route.generation_run_id`, added in the same migration).
//
// `generation_match` is what a rule group matched as of the run's
// `window_from` — one day, so a nightly 7-day run and a 90-day on-demand run
// compare like with like — under `rule_signature`, the planning area, the
// sorted fractions, the vehicle type and the sorted container types the group
// matched under (the domain's `ruleSignature`), with `container_ids` sorted.
// A row is written when the group has no stamp, or its latest stamp has
// another signature or another set; an identical set writes nothing, so the
// two latest rows of a group are its two latest distinct sets, and the drift
// read (`containerDriftBetween`) compares exactly those. One row per group
// per run at most (`generation_match_collection_group_id_generation_run_id_key`).
import { GENERATION_RUN_STATUSES, GENERATION_TRIGGERS } from "@waste/domain/planning/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf } from "./checks"
import { id, projectScoped, timestamps } from "./columns"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { collectionGroup, routeScheme } from "./route-schemes"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const generationRun = wms.table(
  "generation_run",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeSchemeId: uuid().notNull(),
    /** What started the run: the office's button, or the nightly cron. */
    trigger: text().notNull(),
    /** The window asked for, both days inclusive; the walk is capped past the start, which the counts then show. */
    windowFrom: date().notNull(),
    windowTo: date().notNull(),
    status: text().notNull().default("queued"),
    /** pg-boss's job id, where a job carried the run. */
    jobId: text(),
    startedAt: instant(),
    finishedAt: instant(),
    routesCreated: integer().notNull().default(0),
    routesRefreshed: integer().notNull().default(0),
    routesCancelled: integer().notNull().default(0),
    pickupsWritten: integer().notNull().default(0),
    holidaysSkipped: integer().notNull().default(0),
    /** Containers the run could not place on a service date: a matched one whose place has no location, a picked one with no placement valid that day. */
    unlocated: integer().notNull().default(0),
    /** What the run wants read beside its counts: a day with no boundary in force, a rule group on a scheme without a planning area. */
    warnings: text().array().notNull().default(sql`'{}'::text[]`),
    /** The `loggable` projection of what failed: never a statement or its parameters. */
    error: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeSchemeId], routeScheme),
    // A route names the run that last wrote it.
    projectKey(t),
    oneOf(t.trigger, GENERATION_TRIGGERS),
    oneOf(t.status, GENERATION_RUN_STATUSES),
    // A window is a day or more; an inverted one is nothing to walk. No helper spells it because no other table has it.
    check(tableObjectName(t.id.table, "window_ordered", "generationRun"), sql`${t.windowTo} >= ${t.windowFrom}`),
    tenantIndex(t, t.routeSchemeId),
  ],
)

export const generationMatch = wms.table(
  "generation_match",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    collectionGroupId: uuid().notNull(),
    generationRunId: uuid().notNull(),
    /** What the set was matched under: the planning area, the sorted fractions, the vehicle type and the sorted container types; compared whole. */
    ruleSignature: text().notNull(),
    /** The containers the rule matched as of the run's `window_from`, sorted. */
    containerIds: uuid().array().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.collectionGroupId], collectionGroup),
    projectReference(t, [t.generationRunId], generationRun),
    // One stamp per group per run at most.
    tenantUnique(t, t.collectionGroupId, t.generationRunId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.generationRunId),
  ],
)
