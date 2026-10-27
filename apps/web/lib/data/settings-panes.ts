// Which Settings panes are offered with the adapter configured and without it
// (Issues #176, #181). Master data holds rows the API alone keeps, so only
// the Pilot offers it. Asset management's browser store retires on the Pilot:
// its container types and waste fractions are master data there, and its
// other libraries — spare parts, part types, property equipment, key types —
// have no API, and a list only one browser sees is no Pilot list; so only
// fixture mode offers it, and a link to it on the Pilot (the containers
// view's "Asset settings") opens Master data. Finance & invoicing is the
// API's on the Pilot (#291 C4, `FINANCE_ON_API_SETTINGS_PANE_ID`): the
// company's invoice identity and each project's payment terms and reference
// scheme. The browser's pane (`configure.finance` — cost centres, routing
// rules and the rest, which have no API) is fixture mode's alone, and a link
// to either opens the one its mode has. The Sorting Guide (#293) is the
// API's alone too, so only the Pilot offers it. So is the Ticket SLA (O4 of
// #290), which takes the place of Tickets & communication on the Pilot: that
// pane's ticket types, templates and channels have no API, and its SLA is the
// new pane's, so a link to it there opens the SLA. Exception charges (M5 of
// #293), the emission factors (M10 of #293) and the bulky schedules (O11 of
// #290) are the API's alone too.
import { MASTER_DATA_SETTINGS_PANE_ID } from "./business-links"
import { BULKY_SCHEDULES_SETTINGS_PANE_ID } from "./bulky"
import { EMISSION_FACTORS_SETTINGS_PANE_ID } from "./fleet-emissions"
import { PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID } from "./pickup-exception-rules"
import { SORTING_GUIDE_SETTINGS_PANE_ID } from "./sorting-guide"
import { TICKET_SLA_SETTINGS_PANE_ID } from "./ticket-sla"

export const ASSET_MANAGEMENT_SETTINGS_PANE_ID = "asset-management"
export const FINANCE_SETTINGS_PANE_ID = "finance"
/** The fixtures' Tickets & communication, where `configure.templates` opens in fixture mode. */
export const TICKETS_COMMUNICATION_SETTINGS_PANE_ID = "ticket-comms"
/** Settings › Finance & invoicing on the Pilot (#291 C4): the company's invoice identity and the projects' terms and schemes, the API's. */
export const FINANCE_ON_API_SETTINGS_PANE_ID = "finance-invoicing"
/** Settings › Commercial › Products, where a product is added and edited. */
export const COMMERCIAL_PRODUCTS_SETTINGS_PANE_ID = "commercial-products"

/** Whether the Settings nav offers a pane, with the adapter configured or not. */
export function settingsPaneOffered(paneId: string, configured: boolean): boolean {
  if (paneId === MASTER_DATA_SETTINGS_PANE_ID || paneId === SORTING_GUIDE_SETTINGS_PANE_ID || paneId === TICKET_SLA_SETTINGS_PANE_ID || paneId === FINANCE_ON_API_SETTINGS_PANE_ID || paneId === PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID || paneId === EMISSION_FACTORS_SETTINGS_PANE_ID || paneId === BULKY_SCHEDULES_SETTINGS_PANE_ID) return configured
  if (paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID || paneId === FINANCE_SETTINGS_PANE_ID || paneId === TICKETS_COMMUNICATION_SETTINGS_PANE_ID) return !configured
  return true
}

/** The pane a link to one opens: on the Pilot, Asset management's is Master data's, Finance & invoicing's the API's, and Tickets & communication's the Ticket SLA; in fixture mode, the API's Finance pane is the browser's. */
export function settingsPaneOpened(paneId: string, configured: boolean): string {
  if (!configured) return paneId === FINANCE_ON_API_SETTINGS_PANE_ID ? FINANCE_SETTINGS_PANE_ID : paneId
  if (paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID) return MASTER_DATA_SETTINGS_PANE_ID
  if (paneId === FINANCE_SETTINGS_PANE_ID) return FINANCE_ON_API_SETTINGS_PANE_ID
  if (paneId === TICKETS_COMMUNICATION_SETTINGS_PANE_ID) return TICKET_SLA_SETTINGS_PANE_ID
  return paneId
}
