// Which Settings panes are offered with the adapter configured and without
// it (Issues #176, #181): Master data holds rows the API alone keeps, so only
// the Pilot offers it; Asset management's browser store retires on the Pilot
// — its container types and fractions are master data there, and its other
// libraries have no API — so only fixture mode offers it, and a link to it
// on the Pilot opens Master data.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MASTER_DATA_SETTINGS_PANE_ID } from "../business-links"
import { ASSET_MANAGEMENT_SETTINGS_PANE_ID, FINANCE_SETTINGS_PANE_ID, settingsPaneOffered, settingsPaneOpened, TICKETS_COMMUNICATION_SETTINGS_PANE_ID } from "../settings-panes"
import { SORTING_GUIDE_SETTINGS_PANE_ID } from "../sorting-guide"
import { TICKET_SLA_SETTINGS_PANE_ID } from "../ticket-sla"

describe("the Settings panes offered", () => {
  test("Master data on the Pilot only, Asset management in fixture mode only, every other pane in both", () => {
    assert.equal(settingsPaneOffered(MASTER_DATA_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(MASTER_DATA_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOffered(ASSET_MANAGEMENT_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(ASSET_MANAGEMENT_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered("company", true), true)
    assert.equal(settingsPaneOffered("company", false), true)
  })

  test("the Sorting Guide on the Pilot only (#293): its items are the API's alone, with no fixtures", () => {
    assert.equal(settingsPaneOffered(SORTING_GUIDE_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(SORTING_GUIDE_SETTINGS_PANE_ID, false), false)
  })

  test("the Ticket SLA on the Pilot only, in place of Tickets & communication, whose link opens it there (O4 of #290)", () => {
    assert.equal(settingsPaneOffered(TICKET_SLA_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(TICKET_SLA_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOffered(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOpened(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, true), TICKET_SLA_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, false), TICKETS_COMMUNICATION_SETTINGS_PANE_ID)
  })

  test("Finance & invoicing in fixture mode only: configure.finance is hidden on the Pilot (#148)", () => {
    assert.equal(settingsPaneOffered(FINANCE_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(FINANCE_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered("commercial-price-lists", true), true, "Settings › Commercial keeps its price lists in both modes")
    assert.equal(settingsPaneOffered("commercial-products", true), true)
    // A link to it — Configure's Finance module, `/settings?pane=finance` — opens Settings › Commercial on the Pilot, never the browser-only pane.
    assert.equal(settingsPaneOpened(FINANCE_SETTINGS_PANE_ID, true), "commercial-products")
    assert.equal(settingsPaneOpened(FINANCE_SETTINGS_PANE_ID, false), FINANCE_SETTINGS_PANE_ID)
  })

  test("a link to Asset management opens Master data on the Pilot, and itself in fixture mode", () => {
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, true), MASTER_DATA_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, false), ASSET_MANAGEMENT_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened("company", true), "company")
  })
})
