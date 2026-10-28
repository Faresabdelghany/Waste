// Which Settings panes are offered with the adapter configured and without
// it (Issues #176, #181): Master data holds rows the API alone keeps, so only
// the Pilot offers it; Asset management's browser store retires on the Pilot
// — its container types and fractions are master data there, and its other
// libraries have no API — so only fixture mode offers it, and a link to it
// on the Pilot opens Master data.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MASTER_DATA_SETTINGS_PANE_ID } from "../business-links"
import { ASSET_MANAGEMENT_SETTINGS_PANE_ID, FINANCE_ON_API_SETTINGS_PANE_ID, FINANCE_SETTINGS_PANE_ID, PRIVACY_ON_API_SETTINGS_PANE_ID, PRIVACY_SETTINGS_PANE_ID, INTEGRATIONS_ON_API_SETTINGS_PANE_ID, INTEGRATIONS_SETTINGS_PANE_ID, settingsPaneOffered, settingsPaneOpened, TICKETS_COMMUNICATION_SETTINGS_PANE_ID } from "../settings-panes"
import { SORTING_GUIDE_SETTINGS_PANE_ID } from "../sorting-guide"
import { PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID } from "../pickup-exception-rules"
import { EMISSION_FACTORS_SETTINGS_PANE_ID } from "../fleet-emissions"
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

  test("Exception charges on the Pilot only (M5 of #293): the rules are the API's alone", () => {
    assert.equal(settingsPaneOffered(PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID, false), false)
  })

  test("the emission factors on the Pilot only (M10 of #293): they are the API's alone", () => {
    assert.equal(settingsPaneOffered(EMISSION_FACTORS_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(EMISSION_FACTORS_SETTINGS_PANE_ID, false), false)
  })

  test("the Ticket SLA on the Pilot only, in place of Tickets & communication, whose link opens it there (O4 of #290)", () => {
    assert.equal(settingsPaneOffered(TICKET_SLA_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(TICKET_SLA_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOffered(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOpened(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, true), TICKET_SLA_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, false), TICKETS_COMMUNICATION_SETTINGS_PANE_ID)
  })

  test("Finance & invoicing is the API's on the Pilot (#291 C4) and the browser's in fixture mode, one pane in each", () => {
    assert.equal(settingsPaneOffered(FINANCE_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(FINANCE_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered(FINANCE_ON_API_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(FINANCE_ON_API_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOffered("commercial-price-lists", true), true, "Settings › Commercial keeps its price lists in both modes")
    assert.equal(settingsPaneOffered("commercial-products", true), true)
    // A link to it — Configure's Finance module, `/settings?pane=finance` — opens the API's pane on the Pilot, never the browser-only one.
    assert.equal(settingsPaneOpened(FINANCE_SETTINGS_PANE_ID, true), FINANCE_ON_API_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(FINANCE_SETTINGS_PANE_ID, false), FINANCE_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(FINANCE_ON_API_SETTINGS_PANE_ID, false), FINANCE_SETTINGS_PANE_ID, "and the API's pane is the browser's in fixture mode")
  })

  test("Privacy, audit & retention is the API's on the Pilot (#487) and the browser's in fixture mode, one pane in each", () => {
    assert.equal(settingsPaneOffered(PRIVACY_SETTINGS_PANE_ID, true), false, "the browser's GPS purpose and retention policies are never shown to a signed-in API user")
    assert.equal(settingsPaneOffered(PRIVACY_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered(PRIVACY_ON_API_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(PRIVACY_ON_API_SETTINGS_PANE_ID, false), false)
    // A link to it — Configure's Privacy module, `/settings?pane=privacy` — opens the API's pane on the Pilot.
    assert.equal(settingsPaneOpened(PRIVACY_SETTINGS_PANE_ID, true), PRIVACY_ON_API_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(PRIVACY_SETTINGS_PANE_ID, false), PRIVACY_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(PRIVACY_ON_API_SETTINGS_PANE_ID, false), PRIVACY_SETTINGS_PANE_ID)
  })

  test("Integrations is the API's on the Pilot (#487) and the browser's in fixture mode, one pane in each", () => {
    assert.equal(settingsPaneOffered(INTEGRATIONS_SETTINGS_PANE_ID, true), false, "the fixtures' vendor connectors are never shown to a signed-in API user")
    assert.equal(settingsPaneOffered(INTEGRATIONS_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered(INTEGRATIONS_ON_API_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(INTEGRATIONS_ON_API_SETTINGS_PANE_ID, false), false)
    // A link to it — Configure's module, `/settings?pane=integrations` — opens the API's pane on the Pilot.
    assert.equal(settingsPaneOpened(INTEGRATIONS_SETTINGS_PANE_ID, true), INTEGRATIONS_ON_API_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(INTEGRATIONS_SETTINGS_PANE_ID, false), INTEGRATIONS_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(INTEGRATIONS_ON_API_SETTINGS_PANE_ID, false), INTEGRATIONS_SETTINGS_PANE_ID)
  })

  test("a link to Asset management opens Master data on the Pilot, and itself in fixture mode", () => {
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, true), MASTER_DATA_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, false), ASSET_MANAGEMENT_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened("company", true), "company")
  })
})
