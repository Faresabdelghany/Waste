// The vehicle types' pre-trip checklists through the client (O13 of #290):
// Settings › Pre-trip checklists' read of the types and the replacement of a
// type's list. The list is a type's configuration and no row of a
// workspace's table, so it is no switched module: the pane asks the client
// itself, as the Ticket SLA's does.
import type { VehicleTypeChecklistSet } from "@waste/contracts/pre-trip"
import type { VehicleType } from "@waste/contracts/vehicle-types"

import { listAll, put, type ApiClient } from "./client"

/** `GET /vehicle-types`: the company's types, each with its checklist. */
export function readVehicleTypes(client: ApiClient): Promise<VehicleType[]> {
  return listAll<VehicleType>(client, "/vehicle-types")
}

/** `PUT /vehicle-types/:id/checklist`: the type's list replaced whole; answers the type as it now stands. */
export function replaceChecklist(client: ApiClient, vehicleTypeId: string, body: VehicleTypeChecklistSet): Promise<VehicleType> {
  return put<VehicleType>(client, `/vehicle-types/${vehicleTypeId}/checklist`, body)
}
