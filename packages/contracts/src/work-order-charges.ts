// A project's work order charges on the wire (M14 of #293): the product each
// of the office's work orders — a delivery, a removal, a swap, a repair, a
// wash — is charged at when the driver completes it, a service at most once,
// read and replaced whole as a project's ticket charges are (#291 C3,
// tickets.ts). A service the set names no product for is charged nothing.
// Which product will do — the project's, sold by the job, offered — is the
// route's to judge (apps/api/src/routes/work-order-charges.ts).
import { WORK_ORDER_SERVICES } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

import { Id } from "./ids"

/** An office work order's service. */
export const WorkOrderService = z.enum(WORK_ORDER_SERVICES)
export type WorkOrderService = z.infer<typeof WorkOrderService>

/** One service's product: what a completed work order of the service is charged at. */
export const WorkOrderCharge = z.object({ service: WorkOrderService, productId: Id })
export type WorkOrderCharge = z.infer<typeof WorkOrderCharge>

/** `GET /work-order-charges`: a project's charges, a service at most once, in the services' order. */
export const WorkOrderCharges = z.object({ projectId: Id, charges: z.array(WorkOrderCharge) })
export type WorkOrderCharges = z.infer<typeof WorkOrderCharges>

/** What a set naming a service twice is told. */
export const SERVICE_PRICED_ONCE = "Each work order is charged at one product; name a service once"

/** `PUT /work-order-charges`: a project's charges, replaced whole — a service left out is charged at nothing afterwards. */
export const WorkOrderChargesSet = z
  .strictObject({ projectId: Id, charges: z.array(WorkOrderCharge.strict()).max(WORK_ORDER_SERVICES.length) })
  .refine((body) => new Set(body.charges.map((entry) => entry.service)).size === body.charges.length, { message: SERVICE_PRICED_ONCE, path: ["charges"] })
export type WorkOrderChargesSet = z.infer<typeof WorkOrderChargesSet>

/** `GET /work-order-charges`: the project the charges are read for. */
export const WorkOrderChargesQuery = z.object({ projectId: Id })
export type WorkOrderChargesQuery = z.infer<typeof WorkOrderChargesQuery>
