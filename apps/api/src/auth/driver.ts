// Who is driving, and which routes are theirs (Issue #104 §3, §5). The
// office's project-scoped statements carry the tenant and `inProjects`
// (auth/projects.ts); the driver door's carry the tenant and the
// **assignment**, and never Project Access. A route reaches a device because
// the dispatcher assigned it to that driver — `planned_driver_id` before the
// route starts, `actual_driver_id` once a session has started it — and that
// is the whole scope: a Service Provider's driver, whose account works in no
// project at all, reaches exactly the routes assigned to them through this
// door and nothing through any other (#104 §5, "What a Service Provider
// account reaches"; #104 §7.19).
//
// The driver is resolved on every request from the principal's `user.id`
// through `driver.user_account_id`, inside the request's fenced transaction,
// so a deactivated login (403 from the hook on refresh, 403 from
// auth/principal.ts at once) or a driver set `inactive` or `suspended` stops
// the very next batch. A login with no driver profile, or with one that is
// not active, is refused for the whole request with one sentence — not per
// command, since no command from it could stand — and the sentence is the
// same either way: which of the two it is says something about the company
// the caller was not given.
import type { Tx } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { driver } from "@waste/db/schema/fleet"
import type { DriverStatus, LicenceClass } from "@waste/domain/resources/vocabulary"
import { and, eq, or, type SQL } from "drizzle-orm"

import { problem } from "../problem"
import type { Principal } from "./principal"

/** The driver profile a request is made under: what the assignment fence, the sentences and the licence rule read of it. */
export type DriverProfile = {
  id: string
  /** The project the profile is based in; a route assigned to the driver is of the same project by the assignment's own key. */
  projectId: string
  /** As a sentence names them: "Mads Jensen is already on route RC-1039". */
  name: string
  status: DriverStatus
  /** The highest class held, null for none on record; what `decide` judges a `start-route` against. */
  licenceClass: LicenceClass | null
  /** `YYYY-MM-DD`, the last day the licence holds; null for no expiry recorded. */
  licenceExpiry: string | null
}

/** What a request from a login that no active driver profile is bound to is told: the whole request, one sentence. */
export const NOT_A_DRIVERS_LOGIN = "This account is not an active driver's login"

/**
 * The driver profile bound to the principal's account, active, or a 403 for
 * the request. One statement, always with `company_id`: the API binds the
 * claim to the tenant itself and the fence is the second stop (ADR-0001).
 */
export async function resolveDriver(tx: Tx, principal: Principal): Promise<DriverProfile> {
  const [row] = await tx
    .select({ id: driver.id, projectId: driver.projectId, name: driver.name, status: driver.status, licenceClass: driver.licenceClass, licenceExpiry: driver.licenceExpiry })
    .from(driver)
    .where(and(eq(driver.companyId, principal.companyId), eq(driver.userAccountId, principal.user.id)))
    .limit(1)
  if (row === undefined || row.status !== "active") throw problem(403, { detail: NOT_A_DRIVERS_LOGIN })
  // The coded columns are text with a CHECK in the database and a vocabulary here.
  return { ...row, status: row.status as DriverStatus, licenceClass: row.licenceClass as LicenceClass | null }
}

/**
 * The `where` fragment that keeps a route statement to the routes assigned to
 * this driver: planned for them, or started by them. The second fence of the
 * driver door, where `inProjects` is the office's; a route outside it is a
 * route that is not there, answered in the route's own words
 * (`noRouteAssigned`, @waste/domain/execution/commands), so the device learns
 * nothing about routes it was not given.
 */
export function assignedTo(profile: Pick<DriverProfile, "id">): SQL {
  // `or` over two equalities is never undefined; the assertion tells the type so.
  return or(eq(route.plannedDriverId, profile.id), eq(route.actualDriverId, profile.id)) as SQL
}
