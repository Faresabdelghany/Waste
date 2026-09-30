/**
 * Route Schemes — the Route Studio module every scheme surface reads: the
 * list, the scheme page, the wizard, the map's coverage, generation. The
 * module is defined in the Plan workspace's registry and shown in Route
 * Studio only (business-modules.ts), so this is the one place that spells
 * where the records live.
 */
import type { ModuleLocation } from "./business-modules"

export const ROUTE_SCHEMES_MODULE = { workspaceId: "route-studio", moduleId: "schemes" } as const satisfies ModuleLocation

/**
 * The status a scheme edit asks the API for on the Pilot, where the API holds
 * the structural rules and generates the routes: the stored one — the web's
 * own validation never lowers a Validated scheme, the API's 409 speaks for
 * what it refuses — and Validated for a Draft the edit leaves without a
 * blocking issue (`issues` from the live validation; null where there is no
 * recurrence to judge), the browser path's rule (D31). So a scheme an edit
 * refused midway left a Draft (PartialWrite) is validated again by the save
 * that fixes it.
 */
export function schemeEditStatusOnApi(stored: string, issues: readonly string[] | null): string {
  return stored === "Draft" && issues !== null && issues.length === 0 ? "Validated" : stored
}
