// A problem the driver reports on the route, naming no stop, is a kind of its
// own, `route-problem-reported` (F2 of #574); before migration 0114 it was a
// `pickup-problem-reported` about the route. The migration moves what the
// database already holds of that old pair, so every such event is still
// delivered once the release that reads it is live:
//
//   - a job of the old pair that is not done — waiting, retrying or running
//     on an `outbox.<kind>…` queue, or waiting on `outbox.dead` for a
//     redrive — is cancelled as pg-boss's own cancel leaves a job, and its row
//     is unpublished. The new kind's queues are the worker's to make, and
//     pg-boss refuses a job on a queue it does not hold, so a job is not moved
//     onto one: the relay sends the row again once the release's worker runs,
//     to the new kind's consumers, and Resolution's, idempotent by the event's
//     id, answers one it had in fact finished `replayed`;
//   - every row of the old pair, published or not, takes the new kind, so the
//     table holds one aggregate per kind;
//   - until the release's API is live — the release migrates first and
//     deploys after, and a failed deploy leaves the previous API running —
//     that API's insert of the old pair is written as the new kind, by a
//     trigger, so nothing of the old pair is written after the migration.
//
// They follow drizzle-kit's statements, whose change to the table's check
// holds the table under their lock to the end of the migration's
// transaction: no relay stamps a row and no API inserts one between them.
// Until the release's worker runs, the previous one cannot relay a company
// whose outbox holds a row of the new kind: it keeps the company's rows
// unpublished, as it does for any kind it does not know mid-deploy, and the
// release's relay publishes them. The trigger never fires once no writer of
// the old pair is left; a later migration drops it with its function.
import { literal } from "../schema/checks"

/** The kind the problem was, the aggregate that tells the route's apart, and the kind it is. */
const OLD = literal("pickup-problem-reported")
const ROUTE = literal("route")
const NEW = literal("route-problem-reported")

/** The trigger, and its function, that write the old pair as the new kind. */
export const ROUTE_PROBLEM_TRIGGER = "outbox_event_route_problem"

/** The statement that cancels every job of the old pair not done, as `boss.cancel` does, and unpublishes its row for the relay to send again. */
export function resendRouteProblems(): string {
  return (
    `WITH "resent" AS (` +
    `UPDATE "pgboss"."job" SET "completed_on" = "pgboss".job_now(), "state" = 'cancelled' ` +
    `WHERE "name" LIKE 'outbox.%' AND "state" < 'completed' AND "data"->>'kind' = ${OLD} AND "data"->>'aggregateKind' = ${ROUTE} ` +
    `RETURNING ("data"->>'id')::uuid AS "id") ` +
    `UPDATE "wms"."outbox_event" SET "published_at" = NULL WHERE "id" IN (SELECT "id" FROM "resent");`
  )
}

/** The statement that gives every row of the old pair the new kind. */
export function routeProblemKind(): string {
  return `UPDATE "wms"."outbox_event" SET "kind" = ${NEW} WHERE "kind" = ${OLD} AND "aggregate_kind" = ${ROUTE};`
}

/** The function and the trigger that write an insert of the old pair as the new kind. */
export function routeProblemTrigger(): string[] {
  return [
    `CREATE FUNCTION wms.${ROUTE_PROBLEM_TRIGGER}() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ ` +
      `begin if new.kind = ${OLD} and new.aggregate_kind = ${ROUTE} then new.kind := ${NEW}; end if; return new; end $$;`,
    `CREATE TRIGGER "${ROUTE_PROBLEM_TRIGGER}" BEFORE INSERT ON "wms"."outbox_event" FOR EACH ROW EXECUTE FUNCTION wms.${ROUTE_PROBLEM_TRIGGER}();`,
  ]
}

/** Every statement the migration carries below drizzle-kit's, in order. */
export const routeProblemStatements = (): string[] => [resendRouteProblems(), routeProblemKind(), ...routeProblemTrigger()]
