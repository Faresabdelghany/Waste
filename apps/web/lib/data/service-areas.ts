// Where Service Area records live — the module the map's create dialog
// targets — and how the map's typed seed lands in that
// dialog's form. The field ids are this form's (business-form-schemas);
// the domain proposes values without knowing them, and the dialog drops
// any id the schema does not declare, so the mapping lives here and
// __tests__/service-area-seed.test.ts holds it against the schema.
import {
  SERVICE_AREA_POLYGON_KEY,
  serviceAreaPolygonValue,
  type ServiceAreaSeed,
} from "@/lib/prototype/map-planning/service-areas"
import { moduleAt } from "@/lib/modules/keys"

import type { BusinessFormValues } from "./business-form-types"

export const SERVICE_AREAS_MODULE = moduleAt("service-providers.service-areas")

/**
 * Where each field of the map's seed lands: the form's field ids for the
 * values the user sees, the domain's storage key for the polygon. Spelled
 * as a total map over the seed so a field added to ServiceAreaSeed fails
 * the type check here until the web decides where it goes.
 */
export const SERVICE_AREA_SEED_FIELDS = {
  projectId: "projectId",
  planningAreaIds: "zoneIds",
  boundary: "boundary",
  polygon: SERVICE_AREA_POLYGON_KEY,
} satisfies Record<keyof ServiceAreaSeed, string>

/**
 * The map's seed as the Service Area create dialog takes it: the values its
 * form fields start with, and the drawn polygon stored beside them under the
 * domain's key with no field of its own. A project the seed cannot name is
 * left unset, so the workspace's project scope applies as for any create;
 * planning areas it cannot name are left unset, so the field starts empty.
 */
export function serviceAreaFormValues(seed: ServiceAreaSeed): {
  initialValues: BusinessFormValues
  extraValues: BusinessFormValues
} {
  const initialValues: BusinessFormValues = {}
  if (seed.projectId) initialValues[SERVICE_AREA_SEED_FIELDS.projectId] = seed.projectId
  if (seed.planningAreaIds.length > 0) initialValues[SERVICE_AREA_SEED_FIELDS.planningAreaIds] = seed.planningAreaIds.join(",")
  initialValues[SERVICE_AREA_SEED_FIELDS.boundary] = seed.boundary
  const extraValues: BusinessFormValues = seed.polygon
    ? { [SERVICE_AREA_SEED_FIELDS.polygon]: serviceAreaPolygonValue(seed.polygon) }
    : {}
  return { initialValues, extraValues }
}
