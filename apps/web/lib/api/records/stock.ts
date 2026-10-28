// A warehouse's stock on the Pilot (O30 of #290, row 9.8): what stands in it
// by container type, read from `GET /stock-balances?warehouseId=` in its
// details, and the office's Stock Minimums beside it, replaced whole through
// `PUT /warehouses/:id/stock-minimums` as the warehouse's action — the answer
// is the set, not the warehouse, so it is an action and never a command, and
// the row stays as it is. A type is the master data's container type, named
// by its web id in the editor and by its server id on the wire; a blank count
// is no minimum, which the set leaves out, and anything else is a whole
// number of at least one, refused here before the API sees it.
import type { StockBalance, StockBalances, StockMinimums } from "@waste/contracts/stock"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { WAREHOUSES_MODULE } from "@/lib/data/containers"

import { get, put } from "../client"
import type { ActionOutcome, SendAction } from "./server-records"
import type { CommandInput, LocalRefusal, MappingContext, RecordAction } from "./adapter"

/** The warehouse's action that replaces its minimums. */
export const SET_STOCK_MINIMUMS = "set-stock-minimums"

/** One minimum as the editor holds it: the type by web id, the count as typed, blank for none. */
export type MinimumDraft = { containerTypeId: string; minimum: string }

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The editor's drafts as the PUT's body: the blank ones left out, each count a whole number of at least one, each type one the API holds. */
export function stockMinimumsBody(input: CommandInput, _record: BusinessRecord, context: MappingContext): { minimums: Array<{ containerTypeId: string; minimum: number }> } | LocalRefusal {
  const drafts = Array.isArray(input.minimums) ? (input.minimums as MinimumDraft[]) : []
  const minimums: Array<{ containerTypeId: string; minimum: number }> = []
  for (const draft of drafts) {
    const typed = draft.minimum.trim()
    if (typed === "") continue
    if (!/^\d+$/.test(typed) || Number(typed) < 1) return refusal("minimums", "A minimum is a whole number of at least one; leave it blank for none")
    const containerTypeId = context.resolve.serverIdOf(draft.containerTypeId)
    if (containerTypeId === undefined) return refusal("minimums", "Pick a container type the API holds")
    minimums.push({ containerTypeId, minimum: Number(typed) })
  }
  return { minimums }
}

/** `PUT /warehouses/:id/stock-minimums`, the warehouse's action. */
export const SET_STOCK_MINIMUMS_ACTION: RecordAction<StockMinimums> = {
  toBody: stockMinimumsBody,
  run: (client, serverId, body) => put<StockMinimums>(client, `/warehouses/${serverId}/stock-minimums`, body),
  refused: (record) => `The stock minimums of ${record.name} were not saved`,
}

/** Replaces a warehouse's minimums through the store's `sendAction`; the row stays as it is. */
export function setStockMinimums(sendAction: SendAction, recordId: string, minimums: readonly MinimumDraft[]): Promise<ActionOutcome<StockMinimums>> {
  return sendAction(WAREHOUSES_MODULE.workspaceId, WAREHOUSES_MODULE.moduleId, recordId, SET_STOCK_MINIMUMS, { minimums }) as Promise<ActionOutcome<StockMinimums>>
}

/** What stands in one warehouse by type, against its minimums. */
export function warehouseStock(client: Parameters<typeof get>[0], serverId: string): Promise<StockBalance[]> {
  return get<StockBalances>(client, `/stock-balances?warehouseId=${serverId}`).then((answer) => answer.items)
}

/** A balance as its line reads: "12 in stock · 2 in maintenance · minimum 15". */
export function stockLine(balance: Pick<StockBalance, "inWarehouse" | "inMaintenance" | "minimum">): string {
  return [`${balance.inWarehouse} in stock`, ...(balance.inMaintenance > 0 ? [`${balance.inMaintenance} in maintenance`] : []), ...(balance.minimum === null ? [] : [`minimum ${balance.minimum}`])].join(" · ")
}
