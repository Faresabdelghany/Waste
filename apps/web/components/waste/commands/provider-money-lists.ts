// The provider-money chain's lists on the Pilot (Issue #186, #148): the
// categories each module's toolbar filters by, read off the facts its adapter
// writes (lib/api/records/service-areas.ts, provider-money.ts, weights.ts),
// and what it opens on. The service areas' table lists the awards alone,
// never their assignments, which are the same module's second kind and are
// listed in an award's details; the weights open on the desk's queue.
import { singleFilterValue, splitFilterValues } from "@waste/domain/business-filters"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { isServiceAreaRecord } from "@/lib/data/provider-money"
import { REVIEW_LABELS } from "@/lib/api/records/weights"

import type { ModuleList } from "./command-surfaces"

const fact = (key: string) => (record: BusinessRecord) => singleFilterValue(record.facts[key])
const status = (record: BusinessRecord) => [record.status]

export const SERVICE_AREAS_LIST: ModuleList = {
  shows: isServiceAreaRecord,
  readers: () => ({ statuses: status, planningAreas: (record) => splitFilterValues(record.facts["Planning areas"]) }),
  initial: {},
}

export const PROVIDER_PRICES_LIST: ModuleList = {
  readers: () => ({ statuses: status, products: fact("Product"), serviceAreas: fact("Service area") }),
  initial: {},
}

export const SETTLEMENTS_LIST: ModuleList = {
  readers: () => ({ statuses: status, serviceAreas: fact("Service area") }),
  initial: {},
}

/** The weights open on what the desk has still to review (#148). */
export const WEIGHTS_LIST: ModuleList = {
  readers: () => ({ statuses: status, routes: fact("Route"), wasteFractions: fact("Waste fraction") }),
  initial: { statuses: [REVIEW_LABELS.captured] },
}
