// A place's Pickup Exceptions (M5 of #293) as its details read them: each
// stop at a property or a shared point that was missed for the customer, or
// collected and tagged with a contaminant code, newest service date first,
// and what the charge rules in force say of it now — free, charged a
// product, or charged nothing — read from `GET /properties/:id/pickup-
// exceptions` and `GET /shared-collection-points/:id/pickup-exceptions`.
// The judgement is the rules' reading today, not a charge: M5b's consumer
// mints the charge.
import type { PickupException, PickupExceptionHistory } from "@waste/contracts/pickup-exceptions"

import { get, type ApiClient } from "../api/client"
import { allows, type Grants } from "../api/grants"
import { statusLabel } from "../api/records/adapter"

/** The place kinds a history is read for, and the path each is under. */
export type ExceptionPlace = "property" | "shared-point"
const PLACE_PATHS: Readonly<Record<ExceptionPlace, string>> = { property: "/properties", "shared-point": "/shared-collection-points" }

/** The place's history, as the one row `useRowHistory` reads. */
export const placePickupExceptions = (place: ExceptionPlace) => (client: ApiClient, serverId: string): Promise<PickupExceptionHistory[]> =>
  get<PickupExceptionHistory>(client, `${PLACE_PATHS[place]}/${serverId}/pickup-exceptions`).then((history) => [history])

/** Whether the role reads a place's history: the place's module and the stops', the API's two grants for it. */
export const historyReadable = (grants: Grants | undefined, place: ExceptionPlace): boolean =>
  allows(grants, place === "property" ? "customers.properties" : "customers.shared", "view") && allows(grants, "route-studio.pickups", "view")

const ORDINALS = ["1st", "2nd", "3rd"]
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`

/** What happened at the stop: "Skipped: contamination", "Failed: not presented, coded Glass in residual", "Collected, tagged Glass in residual". */
export function exceptionSentence(item: Pick<PickupException, "status" | "reason" | "contaminantCodeId">, codeName: (id: string) => string): string {
  const code = item.contaminantCodeId === null ? null : codeName(item.contaminantCodeId)
  if (item.status === "completed") return code === null ? "Collected" : `Collected, tagged ${code}`
  const said = item.reason === null ? statusLabel(item.status) : `${statusLabel(item.status)}: ${statusLabel(item.reason).toLowerCase()}`
  return code === null ? said : `${said}, coded ${code}`
}

/** What the rules say of it now: free or charged, by its place among the window's matching exceptions; or why nothing is charged. */
export function chargeSentence(item: Pick<PickupException, "judgement" | "origin" | "service">, productName: (id: string) => string): string {
  if (item.judgement === null) {
    if (item.origin === "office") return "Not chargeable: the office's stop"
    if (item.service !== "empty") return "Not chargeable: a work order"
    return "No rule charges it"
  }
  const place = `${ordinal(item.judgement.index + 1)} in the window`
  return item.judgement.productId === null ? `Free · ${place}` : `${productName(item.judgement.productId)} · ${place}`
}

/** The history's count: how many exceptions, how many a rule charges, and whether the latest alone were read. */
export function historySummary(history: PickupExceptionHistory): string {
  const total = history.items.length
  if (total === 0) return "No exceptions in the year before today."
  const charged = history.items.filter((item) => item.judgement?.productId != null).length
  const counted = `${total === 1 ? "One exception" : `${total} exceptions`}, ${charged === 0 ? "none" : charged === total && total > 1 ? "all" : charged} charged under the rules in force`
  return history.truncated ? `${counted}: the latest ${total} are shown.` : `${counted}.`
}
