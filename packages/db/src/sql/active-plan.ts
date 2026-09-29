// The key behind `route.active_plan_id` (#39 S1, migration 0013): the active
// Plan is a plan of this route and no other's, so the key carries the route's
// own id into plan's `(company_id, project_id, route_id, id)` key — and it
// clears itself, `ON DELETE SET NULL (active_plan_id)`, the referencing-column
// subset Postgres 15 added and Drizzle cannot express. Without the subset a
// multi-column SET NULL would null `company_id`, `project_id` and the route's
// own `id`, which their NOT NULLs refuse, and a plain key would knot `route`
// and `plan` into the cycle `sweepOrder` (reset-to-seed.ts) rightly refuses:
// self-clearing, the edge forces no order and the sweep deletes plans first.
// Hand-written into 0013 below drizzle-kit's statements, this function the
// one spelling, active-plan-rendering.test.ts the pin.

/** The statement that keys `route.active_plan_id` into `plan`, for the migration file. */
export function activePlanKey(): string {
  return (
    `ALTER TABLE "wms"."route" ADD CONSTRAINT "route_active_plan_id_fk" ` +
    `FOREIGN KEY ("company_id","project_id","id","active_plan_id") ` +
    `REFERENCES "wms"."plan"("company_id","project_id","route_id","id") ` +
    `ON DELETE SET NULL ("active_plan_id");`
  )
}
