// Which Settings panes are offered with the adapter configured and without it
// (Issues #176, #181). Master data holds rows the API alone keeps, so only
// the Pilot offers it. Asset management's browser store retires on the Pilot:
// its container types and waste fractions are master data there, and its
// other libraries — spare parts, part types, property equipment, key types —
// have no API, and a list only one browser sees is no Pilot list; so only
// fixture mode offers it, and a link to it on the Pilot (the containers
// view's "Asset settings") opens Master data. Finance & invoicing
// (`configure.finance`) is hidden on the Pilot (#148, #112 deferred it): its
// payment terms, cost centres and routing rules have no API, and the Pilot's
// payment terms are the domain's `PAYMENT_TERMS_DAYS`. Fixture mode is
// unchanged. The Sorting Guide (#293) is the API's alone too, so only the
// Pilot offers it.
import { MASTER_DATA_SETTINGS_PANE_ID } from "./business-links"
import { SORTING_GUIDE_SETTINGS_PANE_ID } from "./sorting-guide"

export const ASSET_MANAGEMENT_SETTINGS_PANE_ID = "asset-management"
export const FINANCE_SETTINGS_PANE_ID = "finance"
/** Settings › Commercial › Products, where a link to the Pilot's hidden Finance pane lands. */
export const COMMERCIAL_PRODUCTS_SETTINGS_PANE_ID = "commercial-products"

/** Whether the Settings nav offers a pane, with the adapter configured or not. */
export function settingsPaneOffered(paneId: string, configured: boolean): boolean {
  if (paneId === MASTER_DATA_SETTINGS_PANE_ID || paneId === SORTING_GUIDE_SETTINGS_PANE_ID) return configured
  if (paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID || paneId === FINANCE_SETTINGS_PANE_ID) return !configured
  return true
}

/** The pane a link to one opens: on the Pilot, Asset management's is Master data's, and Finance & invoicing's is Settings › Commercial's products. */
export function settingsPaneOpened(paneId: string, configured: boolean): string {
  if (!configured) return paneId
  if (paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID) return MASTER_DATA_SETTINGS_PANE_ID
  if (paneId === FINANCE_SETTINGS_PANE_ID) return COMMERCIAL_PRODUCTS_SETTINGS_PANE_ID
  return paneId
}
