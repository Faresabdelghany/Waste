// Apply index over many prices through the client (#291 C8): a price list's
// rows (`POST /price-lists/:id/index`) and a provider's or an award's prices
// (`POST /service-provider-prices/index`). The preview (`dryRun`) writes
// nothing, so it goes through the client rather than the store, as Run
// billing's preview does; the write makes many rows and names each on its
// line, so the surface reads the module again rather than handing the store
// a record (apply-index-dialog.tsx).
import type { IndexResult } from "@waste/contracts/finance"
import type { PriceListIndex } from "@waste/contracts/price-lists"
import type { ServiceProviderPriceBulkIndex } from "@waste/contracts/service-provider-prices"

import { command } from "../client"
import type { Client } from "./adapter"

/** `POST /price-lists/:id/index`: the list's rows indexed from a day, or the plan alone with `dryRun`. */
export function indexPriceList(client: Client, listServerId: string, body: PriceListIndex): Promise<IndexResult> {
  return command<IndexResult>(client, `/price-lists/${listServerId}/index`, body)
}

/** `POST /service-provider-prices/index`: every price under one provider or one award indexed from a day, or the plan alone with `dryRun`. */
export function indexProviderPrices(client: Client, body: ServiceProviderPriceBulkIndex): Promise<IndexResult> {
  return command<IndexResult>(client, "/service-provider-prices/index", body)
}
