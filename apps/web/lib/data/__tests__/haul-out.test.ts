// A transfer station's dialogs (M17 of #293): which station shows its stock
// and loads, the projects, stations and vehicles the dialogs offer, and the
// commands a load offers in each status, read off the domain's machine.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { destinationChoices, isTransferStation, loadCommandsOffered, projectChoices, receiptDraft, sendDraft, vehicleChoices } from "../haul-out"

const row = (over: Partial<BusinessRecord>): BusinessRecord => ({ id: "x", name: "x", status: "Active", facts: {}, ...over }) as BusinessRecord

describe("a transfer station's details", () => {
  test("show for an unloading station the office says is a transfer station, and for no other", () => {
    assert.equal(isTransferStation(row({ submittedValues: { locationType: "unloading", transferStation: true } })), true)
    assert.equal(isTransferStation(row({ submittedValues: { locationType: "unloading", transferStation: false } })), false)
    assert.equal(isTransferStation(row({ submittedValues: { locationType: "depot", transferStation: true } })), false)
  })

  test("offer the projects with their clocks and currencies, the other open stations, and our vehicles of the project in service", () => {
    const records = [
      row({ id: "project-b", name: "Harbor", recordKind: "Project", submittedValues: { timezone: "Europe/Copenhagen", currency: "DKK" } }),
      row({ id: "project-a", name: "Copenhagen", recordKind: "Project", submittedValues: { timezone: "Europe/Copenhagen", currency: "EUR" } }),
      row({ id: "company", name: "Kystbyen", recordKind: "Company" }),
    ]
    assert.deepEqual(projectChoices(records), [
      { value: "project-a", label: "Copenhagen", timezone: "Europe/Copenhagen", currency: "EUR" },
      { value: "project-b", label: "Harbor", timezone: "Europe/Copenhagen", currency: "DKK" },
    ])
    const stations = [
      row({ id: "station-omlast", name: "Omlast", submittedValues: { locationType: "unloading" } }),
      row({ id: "station-arc", name: "ARC Amager", submittedValues: { locationType: "unloading" } }),
      row({ id: "station-old", name: "Old plant", status: "Closed", submittedValues: { locationType: "unloading" } }),
      row({ id: "depot-nord", name: "Nordhavn", submittedValues: { locationType: "depot" } }),
    ]
    assert.deepEqual(destinationChoices(stations, "station-omlast"), [{ value: "station-arc", label: "ARC Amager" }])
    const vehicles = [
      row({ id: "vehicle-wh24", recordKind: "Vehicle or trailer", projectIds: ["project-a"], submittedValues: { registrationNumber: "CN 42 018" } }),
      row({ id: "vehicle-old", recordKind: "Vehicle or trailer", projectIds: ["project-a"], status: "Retired", submittedValues: { registrationNumber: "CN 11 999" } }),
      row({ id: "vehicle-harbor", recordKind: "Vehicle or trailer", projectIds: ["project-b"], submittedValues: { registrationNumber: "CN 77 001" } }),
    ]
    assert.deepEqual(vehicleChoices(vehicles, "project-a"), [{ value: "vehicle-wh24", label: "CN 42 018" }])
  })

  test("start a load departed now and a receipt received now, on the project's clock", () => {
    assert.equal(sendDraft("project-a", "2026-10-29T10:00").departedAt, "2026-10-29T10:00")
    assert.deepEqual(receiptDraft("load-1", "2026-10-29T11:00"), { loadId: "load-1", receivingTicket: "", receivedNetKg: "", receivedAt: "2026-10-29T11:00" })
  })

  test("a load offers the commands the domain's machine moves it by: received or cancelled once it left, then reconciled, disputed or its receipt corrected", () => {
    assert.deepEqual(loadCommandsOffered("departed"), ["receive", "cancel"])
    assert.deepEqual(loadCommandsOffered("received"), ["receive", "reconcile", "dispute"])
    assert.deepEqual(loadCommandsOffered("disputed"), ["receive", "reconcile"])
    assert.deepEqual(loadCommandsOffered("reconciled"), [])
    assert.deepEqual(loadCommandsOffered("cancelled"), [])
  })
})
