// What the Price Engine's pickers offer on the Pilot (Issues #185, #186): the
// pure half of `useCommercialPickers` (components/waste/commands/
// commercial-pickers.ts) for the fields the money chains add — a price list,
// a product, a planning area, an agreement; a provider, an award's planning
// areas and fractions, a service area and an assignment. Every row is offered,
// its status beside its name (#79: a status gates a new reference, and the
// API's 409 says so), but a product and a planning area only of the project
// the dialog names: through its price list, its agreement or its project
// field, else the surface's own — each project keeps a catalogue of its own
// under the same names, and a row of another project is one the API refuses.
import { planningAreaAdapter } from "@/lib/api/records/planning"

import { isAgreementRecord } from "./agreements"
import type { BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"
import { isPriceListRecord } from "./commercial"
import { masterDataKindOf } from "./master-data-kinds"
import { isAssignmentRecord, isServiceAreaRecord } from "./provider-money"

/** The rows the store holds of the modules the chain's dialogs pick from. */
export type CommercialPickerRows = {
  products: readonly BusinessRecord[]
  priceRows: readonly BusinessRecord[]
  areas: readonly BusinessRecord[]
  agreements: readonly BusinessRecord[]
  /** The provider-money chain's (#186): the service providers, the master data, and the service areas module's areas and assignments. */
  providers?: readonly BusinessRecord[]
  master?: readonly BusinessRecord[]
  serviceAreas?: readonly BusinessRecord[]
}

const picked = (values: BusinessFormValues, key: string) => (typeof values[key] === "string" && values[key] !== "" ? (values[key] as string) : undefined)

/** The project a dialog names: its list's, its agreement's, its assignment's, its own project field, else the surface's. */
function projectOf(values: BusinessFormValues, rows: CommercialPickerRows, projectId: string | undefined): string | undefined {
  const named = (key: string, among: readonly BusinessRecord[] | undefined) => {
    const id = picked(values, key)
    return id === undefined ? undefined : among?.find((record) => record.id === id)?.projectIds?.[0]
  }
  return named("priceListId", rows.priceRows) ?? named("agreementId", rows.agreements) ?? named("serviceAreaAssignmentId", rows.serviceAreas) ?? picked(values, "projectId") ?? projectId
}

/** A row of the project, or of any where the dialog names none; a row of no project is everyone's. */
const ofProject = (project: string | undefined) => (record: BusinessRecord) => project === undefined || !record.projectIds?.length || record.projectIds.includes(project)

/** The rows a chain field offers, or undefined for a field the command surfaces' own pickers answer. */
export function commercialRowsFor(fieldId: string, values: BusinessFormValues, rows: CommercialPickerRows, projectId?: string): readonly BusinessRecord[] | undefined {
  switch (fieldId) {
    case "priceListId":
      return rows.priceRows.filter(isPriceListRecord)
    case "agreementId":
      return rows.agreements.filter(isAgreementRecord)
    case "productId":
      return rows.products.filter(ofProject(projectOf(values, rows, projectId)))
    case "planningAreaId":
    case "zoneIds":
      return rows.areas.filter(planningAreaAdapter.owns).filter(ofProject(projectOf(values, rows, projectId)))
    case "serviceProviderId":
      return rows.providers ?? []
    case "wasteFractionIds":
      return (rows.master ?? []).filter((record) => masterDataKindOf(record) === "waste-fraction")
    case "serviceAreaId":
      return (rows.serviceAreas ?? []).filter(isServiceAreaRecord).filter(ofProject(projectOf(values, rows, projectId)))
    case "serviceAreaAssignmentId":
      return (rows.serviceAreas ?? []).filter(isAssignmentRecord).filter(ofProject(projectOf(values, rows, projectId)))
    default:
      return undefined
  }
}
