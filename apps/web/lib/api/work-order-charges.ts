// A project's work order charges through the client (M14 of #293): Settings ›
// Commercial › Work order charges' read and the replacement of its set. The
// set is a project's configuration and no row of a workspace's table, so it
// is no switched module: the pane asks the client itself, as Ticket charges'
// does.
import type { WorkOrderCharges, WorkOrderChargesSet } from "@waste/contracts/work-order-charges"

import { get, put, withQuery, type ApiClient } from "./client"

/** `GET /work-order-charges`: the product each work order of the project is charged at, a service at most once. */
export function readWorkOrderCharges(client: ApiClient, projectId: string): Promise<WorkOrderCharges> {
  return get<WorkOrderCharges>(client, withQuery("/work-order-charges", { projectId }))
}

/** `PUT /work-order-charges`: the project's set replaced whole; answers it as it now stands. */
export function replaceWorkOrderCharges(client: ApiClient, body: WorkOrderChargesSet): Promise<WorkOrderCharges> {
  return put<WorkOrderCharges>(client, "/work-order-charges", body)
}
