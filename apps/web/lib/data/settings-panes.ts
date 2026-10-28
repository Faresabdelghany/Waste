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
// #293), the emission factors (M10 of #293), the bulky schedules (O11 of
// #290) and the recycling-centre charges (#393) are the API's alone too.
// Privacy, audit & retention is the API's on the Pilot (#487,
// `PRIVACY_ON_API_SETTINGS_PANE_ID`): the company's audit history and the
// controls the platform enforces; the browser's pane (`configure.privacy` —
// the GPS purpose and the retention policies, C19's with no API yet) is
// fixture mode's alone, and a link to either opens the one its mode has.
// Integrations is the API's on the Pilot (#487,
// `INTEGRATIONS_ON_API_SETTINGS_PANE_ID`): the services the deployment calls
// and the latest import; the browser's pane (`configure.integrations` — the
// fixtures' vendor connectors, which no API holds) is fixture mode's alone,
// and a link to either opens the one its mode has.
// Portals & branding is the API's on the Pilot (#487,
// `PORTALS_ON_API_SETTINGS_PANE_ID`): each project's public pages and its
// drivers' Driver App; the browser's pane (`configure.portals` — a customer
// portal and branding, C20–C22's and M22's with no API yet) is fixture
// mode's alone, and a link to either opens the one its mode has.
import { MASTER_DATA_SETTINGS_PANE_ID } from "./business-links"
import { BULKY_SCHEDULES_SETTINGS_PANE_ID } from "./bulky"
import { EMISSION_FACTORS_SETTINGS_PANE_ID } from "./fleet-emissions"
import { PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID } from "./pickup-exception-rules"
import { VISIT_RULES_SETTINGS_PANE_ID } from "./site-visits"
import { SORTING_GUIDE_SETTINGS_PANE_ID } from "./sorting-guide"
import { TICKET_SLA_SETTINGS_PANE_ID } from "./ticket-sla"

export const ASSET_MANAGEMENT_SETTINGS_PANE_ID = "asset-management"
export const FINANCE_SETTINGS_PANE_ID = "finance"
/** The fixtures' Tickets & communication, where `configure.templates` opens in fixture mode. */
export const TICKETS_COMMUNICATION_SETTINGS_PANE_ID = "ticket-comms"
/** Settings › Finance & invoicing on the Pilot (#291 C4): the company's invoice identity and the projects' terms and schemes, the API's. */
export const FINANCE_ON_API_SETTINGS_PANE_ID = "finance-invoicing"
/** The fixtures' Privacy, audit & retention, where `configure.privacy` opens in fixture mode. */
export const PRIVACY_SETTINGS_PANE_ID = "privacy"
/** Settings › Privacy, audit & retention on the Pilot (#487): the company's audit history, the API's. */
export const PRIVACY_ON_API_SETTINGS_PANE_ID = "privacy-audit"
/** The fixtures' Integrations, where `configure.integrations` opens in fixture mode. */
export const INTEGRATIONS_SETTINGS_PANE_ID = "integrations"
/** Settings › Integrations on the Pilot (#487): the deployment's connections, the API's. */
export const INTEGRATIONS_ON_API_SETTINGS_PANE_ID = "integrations-on-api"
/** The fixtures' Portals & branding, where `configure.portals` opens in fixture mode. */
export const PORTALS_SETTINGS_PANE_ID = "portals"
/** Settings › Portals & branding on the Pilot (#487): the projects' public pages and the Driver App, the API's. */
export const PORTALS_ON_API_SETTINGS_PANE_ID = "portals-on-api"
/** Settings › Commercial › Products, where a product is added and edited. */
export const COMMERCIAL_PRODUCTS_SETTINGS_PANE_ID = "commercial-products"

/** Whether the Settings nav offers a pane, with the adapter configured or not. */
export function settingsPaneOffered(paneId: string, configured: boolean): boolean {
  if (paneId === MASTER_DATA_SETTINGS_PANE_ID || paneId === SORTING_GUIDE_SETTINGS_PANE_ID || paneId === TICKET_SLA_SETTINGS_PANE_ID || paneId === FINANCE_ON_API_SETTINGS_PANE_ID || paneId === PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID || paneId === EMISSION_FACTORS_SETTINGS_PANE_ID || paneId === BULKY_SCHEDULES_SETTINGS_PANE_ID || paneId === VISIT_RULES_SETTINGS_PANE_ID || paneId === PRIVACY_ON_API_SETTINGS_PANE_ID || paneId === INTEGRATIONS_ON_API_SETTINGS_PANE_ID || paneId === PORTALS_ON_API_SETTINGS_PANE_ID) return configured
  if (paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID || paneId === FINANCE_SETTINGS_PANE_ID || paneId === TICKETS_COMMUNICATION_SETTINGS_PANE_ID || paneId === PRIVACY_SETTINGS_PANE_ID || paneId === INTEGRATIONS_SETTINGS_PANE_ID || paneId === PORTALS_SETTINGS_PANE_ID) return !configured
  return true
}

/** The pane a link to one opens: on the Pilot, Asset management's is Master data's, Finance & invoicing's, Privacy's, Integrations' and Portals & branding's the API's, and Tickets & communication's the Ticket SLA; in fixture mode, the API's Finance, Privacy, Integrations and Portals panes are the browser's. */
export function settingsPaneOpened(paneId: string, configured: boolean): string {
  if (!configured) {
    if (paneId === FINANCE_ON_API_SETTINGS_PANE_ID) return FINANCE_SETTINGS_PANE_ID
    if (paneId === PRIVACY_ON_API_SETTINGS_PANE_ID) return PRIVACY_SETTINGS_PANE_ID
    if (paneId === INTEGRATIONS_ON_API_SETTINGS_PANE_ID) return INTEGRATIONS_SETTINGS_PANE_ID
    return paneId === PORTALS_ON_API_SETTINGS_PANE_ID ? PORTALS_SETTINGS_PANE_ID : paneId
  }
  if (paneId === PRIVACY_SETTINGS_PANE_ID) return PRIVACY_ON_API_SETTINGS_PANE_ID
  if (paneId === INTEGRATIONS_SETTINGS_PANE_ID) return INTEGRATIONS_ON_API_SETTINGS_PANE_ID
  if (paneId === PORTALS_SETTINGS_PANE_ID) return PORTALS_ON_API_SETTINGS_PANE_ID
  if (paneId === ASSET_MANAGEMENT_SETTINGS_PANE_ID) return MASTER_DATA_SETTINGS_PANE_ID
  if (paneId === FINANCE_SETTINGS_PANE_ID) return FINANCE_ON_API_SETTINGS_PANE_ID
  if (paneId === TICKETS_COMMUNICATION_SETTINGS_PANE_ID) return TICKET_SLA_SETTINGS_PANE_ID
  return paneId
}
