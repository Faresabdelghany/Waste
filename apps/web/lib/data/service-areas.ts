// Where Service Area records live — the module the map's create dialog
// targets. Resolved from the registry like PLANNING_AREAS_MODULE; never
// hard-code the pair.
import { publicModuleDomains } from "./business-domain"
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
