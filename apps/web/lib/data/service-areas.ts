// Where Service Area records live — the module the map's create dialog
// targets, resolved from the registry like PLANNING_AREAS_MODULE (never
// hard-code the pair) — and how the map's typed seed lands in that
// dialog's form. The field ids are this form's (business-form-schemas);
// the domain proposes values without knowing them, and the dialog drops
// any id the schema does not declare, so the mapping lives here and
// __tests__/service-area-seed.test.ts holds it against the schema.
import {
  SERVICE_AREA_POLYGON_KEY,
  serviceAreaPolygonValue,
  type ServiceAreaSeed,
} from "@waste/domain/map-planning/service-areas"

import { publicModuleDomains } from "./business-domain"
import type { BusinessFormValues } from "./business-form-types"
import type { ModuleLocation } from "./business-modules"

const serviceAreasDomain = publicModuleDomains.find(
  (module) => module.key === "service-providers.service-areas",
)
if (!serviceAreasDomain) {
  throw new Error("service-providers.service-areas is missing from publicModuleDomains")
}

export const SERVICE_AREAS_MODULE: ModuleLocation = {
  workspaceId: serviceAreasDomain.workspaceId,
  moduleId: serviceAreasDomain.moduleId,
}

/**
 * The map's seed as the Service Area create dialog takes it: the values its
 * form fields start with, and the drawn polygon stored beside them under the
 * domain's key with no field of its own. A project or planning areas the
 * seed cannot name are left unset, so the form shows its placeholders.
 */
export function serviceAreaFormValues(seed: ServiceAreaSeed): {
  initialValues: BusinessFormValues
  extraValues: BusinessFormValues
} {
  const initialValues: BusinessFormValues = {}
  if (seed.projectId) initialValues.projectId = seed.projectId
  if (seed.planningAreaIds.length > 0) initialValues.zoneIds = seed.planningAreaIds.join(",")
  initialValues.boundary = seed.boundary
  const extraValues: BusinessFormValues = seed.polygon
    ? { [SERVICE_AREA_POLYGON_KEY]: serviceAreaPolygonValue(seed.polygon) }
    : {}
  return { initialValues, extraValues }
}
