// Scheme deletion orchestration (issue #34). Pure data logic — no UI or store
// dependencies — the single planner behind "Delete scheme": deletion is a
// safe boundary, not an eraser. The scheme is soft-deleted (marked, never
// removed) with Plan Ahead off, so no auto-run or manual generation touches
// it again; its future refreshable (Draft/Planned) routes are cancelled —
// never deleted — through the engine's shared generation-authored cancel
// shape with their open pickups skipped; and every route that is operational
// reality (past or today's, Ready/Active/Completed, operationally Cancelled)
// stays exactly as stored, Stops/Pickups included, as history.

import type { BusinessRecord } from "../data/business-modules"
import { softDeletedRecord, type SoftDeletion } from "../data/record-visibility"
import { cancelSchemeFutureRoutes, stringValueOf } from "./generation"
import { setPlanAhead } from "./plan-ahead"
import { addDays } from "./recurrence"
import { count } from "./text"

export type SchemeDeletionInput = SoftDeletion & {
  /**
   * The STORED scheme record — never the derived display record: the
   * status/context seams are render-time and must not be frozen into the
   * store by the delete write.
   */
  scheme: BusinessRecord
  today: string
  /** ISO datetime stamped on the cancelled routes; omitted for deterministic runs. */
  generatedAt?: string
}

export type SchemeDeletionRelated = {
  existingRoutes: readonly BusinessRecord[]
  existingPickups: readonly BusinessRecord[]
}

export type SchemeDeletionPlan = {
  /** The scheme record to persist: soft-delete marker applied, Plan Ahead off. */
  scheme: BusinessRecord
  /** Route records to upsert under route-studio.routes (the cancels). */
  routes: BusinessRecord[]
  /** Pickup records to upsert under route-studio.pickups (the skips). */
  pickups: BusinessRecord[]
  /**
   * The scheme's routes this plan left untouched — operational history
   * (past, today's, Ready/Active/Completed, operationally cancelled) and
   * earlier generation-authored cancels alike.
   */
  preserved: number
  /** Human-readable consequence line for toasts. */
  message: string
}

/** The one wording for a scheme-deleted cancellation (SPEC H). */
export const SCHEME_DELETED_CANCEL_NOTE =
  "Route scheme deleted — future planning stopped"

function deletionMessage(cancelled: number, preserved: number): string {
  if (cancelled === 0 && preserved === 0) {
    return "Deleted — no generated routes existed. Future planning stopped."
  }
  const parts = [
    cancelled > 0
      ? `${count(cancelled, "future route")} cancelled and kept as ${cancelled === 1 ? "a record" : "records"}`
      : "no future planned routes to cancel",
    preserved > 0 ? `${count(preserved, "route")} left untouched as history` : null,
  ].filter(Boolean)
  return `Deleted — ${parts.join("; ")}. Future planning stopped.`
}

/**
 * The deletion planner (SPEC area H, D32): decides everything that happens
 * after "Delete scheme" is confirmed and returns every upsert the handler
 * must apply. The scheme comes back soft-deleted with Plan Ahead off — and
 * the eligibility seams (schemeAutoGenerates, schemeCanGenerateRoutes) refuse
 * soft-deleted schemes regardless, so a scheme deleted before this flag
 * existed stops too. Future refreshable routes from tomorrow onward are
 * cancelled with the resurrection marker: unbounded, unlike the edit path's
 * walk-cap bound, because nothing will ever resurrect them — the cap's
 * one-way-door concern does not apply, while a dangling far-future Planned
 * route from a deleted scheme would be exactly the bug D32 closes. Today's
 * routes are operating (the Plan Ahead convention) and stay.
 */
export function planSchemeDeletion(
  input: SchemeDeletionInput,
  related: SchemeDeletionRelated,
): SchemeDeletionPlan {
  const { scheme, today } = input
  const cancels = cancelSchemeFutureRoutes({
    schemeId: scheme.id,
    from: addDays(today, 1),
    existingRoutes: related.existingRoutes,
    existingPickups: related.existingPickups,
    note: SCHEME_DELETED_CANCEL_NOTE,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  })
  const cancelledIds = new Set(cancels.routes.map((route) => route.id))
  const preserved = related.existingRoutes.filter(
    (route) =>
      stringValueOf(route, "schemeId") === scheme.id && !cancelledIds.has(route.id),
  ).length
  return {
    scheme: softDeletedRecord(setPlanAhead(scheme, false), input),
    routes: cancels.routes,
    pickups: cancels.pickups,
    preserved,
    message: deletionMessage(cancels.routes.length, preserved),
  }
}
