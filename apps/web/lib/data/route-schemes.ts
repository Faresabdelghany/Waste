/**
 * Route Schemes — the Route Studio module every scheme surface reads: the
 * list, the scheme page, the wizard, the map's coverage, generation. The
 * module is defined in the Plan workspace's registry and shown in Route
 * Studio only (business-modules.ts), so this is the one place that spells
 * where the records live.
 */
import type { ModuleLocation } from "./business-modules"

export const ROUTE_SCHEMES_MODULE = { workspaceId: "route-studio", moduleId: "schemes" } as const satisfies ModuleLocation
