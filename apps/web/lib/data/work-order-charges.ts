// A project's work order charges on the web (M14 of #293): the product each
// of the office's work orders — a delivery, a removal, a swap, a repair, a
// wash — is charged at when the driver completes it, as Settings › Commercial
// › Work order charges reads and writes it (`GET`/`PUT
// /work-order-charges`). Only a product sold by the job is offered — the
// route's own rule (400) — and a retired one by its status, since a status
// gates a new reference and the API's 409 says why (#79). The set goes out
// whole, by the server's ids, a service left at None charged at nothing.
import type { WorkOrderCharges, WorkOrderChargesSet } from "@waste/contracts/work-order-charges"
import { WORK_ORDER_SERVICES, type WorkOrderService } from "@waste/domain/execution/vocabulary"

import type { LocalRefusal } from "@/lib/api/records/adapter"
import type { BusinessFormOption } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PICKUP_SERVICE_LABELS } from "@/lib/data/pickup-services"
import { NO_ONE } from "@/lib/data/properties"

/** The unit a work order's job is sold in. */
const JOB_UNIT = "job"

/** The products of the project a work order may be charged at, by the products module's records: only one sold by the job, a retired one by its status. */
export function jobProductOptions(products: readonly BusinessRecord[], projectId: string | undefined): BusinessFormOption[] {
  return products
    .filter((record) => (projectId === undefined || (record.projectIds ?? []).includes(projectId)) && record.submittedValues?.priceUnit === JOB_UNIT)
    .map((record) => ({ value: record.id, label: record.status === "Active" ? record.name : `${record.name} · ${record.status}` }))
}

/** The work orders as the pane lists them: every service once, in the vocabulary's order, by its label. */
export const WORK_ORDER_ROWS: readonly { service: WorkOrderService; label: string }[] = WORK_ORDER_SERVICES.map((service) => ({ service, label: PICKUP_SERVICE_LABELS[service] }))

/** A service's pick in the pane: the product's id, or None. */
export type WorkOrderChargePicks = Partial<Record<WorkOrderService, string>>

/** The set as picks by the store's ids; a product the store has not loaded is kept by its server id. */
export function workOrderPicksOf(set: WorkOrderCharges, webIdOf: (serverId: string) => string | undefined): WorkOrderChargePicks {
  return Object.fromEntries(set.charges.map((entry) => [entry.service, webIdOf(entry.productId) ?? entry.productId]))
}

/** The body the pane sends: every service picked at a product, by the server's ids, in the services' order; a service at None is left out and charged at nothing. */
export function workOrderChargesBody(projectId: string, picks: WorkOrderChargePicks, serverIdOf: (webId: string) => string | undefined): WorkOrderChargesSet | LocalRefusal {
  const charges: WorkOrderChargesSet["charges"] = []
  for (const { service } of WORK_ORDER_ROWS) {
    const pick = picks[service]
    if (pick === undefined || pick === NO_ONE || pick === "") continue
    const productId = serverIdOf(pick)
    if (productId === undefined) return { path: service, message: "Pick a product the API holds" }
    charges.push({ service, productId })
  }
  return { projectId, charges }
}
