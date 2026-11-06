// Which Settings panes are offered with the adapter configured and without
// it (Issues #176, #181): Master data holds rows the API alone keeps, so only
// the Pilot offers it; Asset management's browser store retires on the Pilot
// — its container types and fractions are master data there, and its other
// libraries have no API — so only fixture mode offers it, and a link to it
// on the Pilot opens Master data.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MASTER_DATA_SETTINGS_PANE_ID } from "../business-links"
import { ASSET_MANAGEMENT_SETTINGS_PANE_ID, FINANCE_ON_API_SETTINGS_PANE_ID, FINANCE_SETTINGS_PANE_ID, INTEGRATIONS_ON_API_SETTINGS_PANE_ID, INTEGRATIONS_SETTINGS_PANE_ID, PORTALS_ON_API_SETTINGS_PANE_ID, PORTALS_SETTINGS_PANE_ID, ACCOUNT_SETTINGS_PANE_ID, COMMERCIAL_DEFAULTS_SETTINGS_PANE_ID, COMMERCIAL_PRODUCTS_SETTINGS_PANE_ID, NOTIFICATIONS_ON_API_SETTINGS_PANE_ID, NOTIFICATIONS_SETTINGS_PANE_ID, OPERATIONS_SETUP_SETTINGS_PANE_ID, settingsPaneOffered, settingsPaneOpened, TICKETS_COMMUNICATION_SETTINGS_PANE_ID } from "../settings-panes"
import { PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID } from "../pickup-exception-rules"
import { TICKET_SLA_SETTINGS_PANE_ID } from "../ticket-sla"
import { TICKET_TEAMS_SETTINGS_PANE_ID } from "../ticket-teams"
import { TICKET_TYPES_SETTINGS_PANE_ID } from "../ticket-types"
import { COUNTING_RULES_SETTINGS_PANE_ID } from "../counting-rules"
import { TICKET_CHARGES_SETTINGS_PANE_ID, TICKETS_SETTINGS_PANE_ID, TICKETS_TABS, ticketsTabOf } from "../tickets-settings"

describe("the Settings panes offered", () => {
  test("Master data on the Pilot only, Asset management in fixture mode only, every other pane in both", () => {
    assert.equal(settingsPaneOffered(MASTER_DATA_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(MASTER_DATA_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOffered(ASSET_MANAGEMENT_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(ASSET_MANAGEMENT_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered("company", true), true)
    assert.equal(settingsPaneOffered("company", false), true)
  })

  test("Exception charges on the Pilot only (M5 of #293): the rules are the API's alone", () => {
    assert.equal(settingsPaneOffered(PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(PICKUP_EXCEPTION_CHARGES_SETTINGS_PANE_ID, false), false)
  })

  test("Settings › Tickets on the Pilot only, in place of Tickets & communication, whose link opens it there at its deadlines (O4 of #290, #548 of #544)", () => {
    assert.equal(settingsPaneOffered(TICKETS_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(TICKETS_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOffered(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, true), false)
    assert.equal(settingsPaneOffered(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOpened(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, true), TICKETS_SETTINGS_PANE_ID)
    assert.equal(ticketsTabOf(TICKETS_COMMUNICATION_SETTINGS_PANE_ID), "deadlines")
    assert.equal(settingsPaneOpened(TICKETS_COMMUNICATION_SETTINGS_PANE_ID, false), TICKETS_COMMUNICATION_SETTINGS_PANE_ID)
  })

  test("the five ticket panes the Tickets page took the place of open it at their tab, so a link made before it reads as it did (#548 of #544)", () => {
    const opened: [string, string][] = [
      [TICKET_TYPES_SETTINGS_PANE_ID, "types"],
      [TICKET_TEAMS_SETTINGS_PANE_ID, "teams"],
      [TICKET_SLA_SETTINGS_PANE_ID, "deadlines"],
      [TICKET_CHARGES_SETTINGS_PANE_ID, "charges"],
      [COUNTING_RULES_SETTINGS_PANE_ID, "counting-rules"],
    ]
    for (const [paneId, tab] of opened) {
      assert.equal(settingsPaneOpened(paneId, true), TICKETS_SETTINGS_PANE_ID, paneId)
      assert.equal(ticketsTabOf(paneId), tab, paneId)
    }
    assert.equal(ticketsTabOf(undefined), "types")
    assert.deepEqual(TICKETS_TABS.map((tab) => tab.label), ["Types", "Teams", "Deadlines", "Charges", "Counting rules"])
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

  test("Portals & branding is the API's on the Pilot (#487) and the browser's in fixture mode, one pane in each", () => {
    assert.equal(settingsPaneOffered(PORTALS_SETTINGS_PANE_ID, true), false, "the fixtures' customer portal and branding are never shown to a signed-in API user")
    assert.equal(settingsPaneOffered(PORTALS_SETTINGS_PANE_ID, false), true)
    assert.equal(settingsPaneOffered(PORTALS_ON_API_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(PORTALS_ON_API_SETTINGS_PANE_ID, false), false)
    // A link to it — Configure's module, `/settings?pane=portals` — opens the API's pane on the Pilot.
    assert.equal(settingsPaneOpened(PORTALS_SETTINGS_PANE_ID, true), PORTALS_ON_API_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(PORTALS_SETTINGS_PANE_ID, false), PORTALS_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(PORTALS_ON_API_SETTINGS_PANE_ID, false), PORTALS_SETTINGS_PANE_ID)
  })

  test("Operations setup, Commercial defaults and Notifications, which only this browser keeps, are fixture mode's alone (#487); on the Pilot a link to one opens where its subject lives", () => {
    for (const [pane, landing] of [
      [OPERATIONS_SETUP_SETTINGS_PANE_ID, MASTER_DATA_SETTINGS_PANE_ID],
      [COMMERCIAL_DEFAULTS_SETTINGS_PANE_ID, COMMERCIAL_PRODUCTS_SETTINGS_PANE_ID],
      [NOTIFICATIONS_SETTINGS_PANE_ID, NOTIFICATIONS_ON_API_SETTINGS_PANE_ID],
    ]) {
      assert.equal(settingsPaneOffered(pane, true), false, pane)
      assert.equal(settingsPaneOffered(pane, false), true, pane)
      assert.equal(settingsPaneOpened(pane, true), landing, pane)
      assert.equal(settingsPaneOpened(pane, false), pane, pane)
    }
    assert.equal(settingsPaneOffered(ACCOUNT_SETTINGS_PANE_ID, true), true, "Account & appearance stays: its profile is /me's and its theme is the device's own")
  })

  test("Notifications on the API (O16 of #290) is the Pilot's alone, and a link to it opens the browser's in fixture mode", () => {
    assert.equal(settingsPaneOffered(NOTIFICATIONS_ON_API_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(NOTIFICATIONS_ON_API_SETTINGS_PANE_ID, false), false)
    assert.equal(settingsPaneOpened(NOTIFICATIONS_ON_API_SETTINGS_PANE_ID, true), NOTIFICATIONS_ON_API_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(NOTIFICATIONS_ON_API_SETTINGS_PANE_ID, false), NOTIFICATIONS_SETTINGS_PANE_ID)
  })

  test("a link to Asset management opens Master data on the Pilot, and itself in fixture mode", () => {
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, true), MASTER_DATA_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened(ASSET_MANAGEMENT_SETTINGS_PANE_ID, false), ASSET_MANAGEMENT_SETTINGS_PANE_ID)
    assert.equal(settingsPaneOpened("company", true), "company")
  })
})
