// The workspace's Export (#292, #291 slice 28): the CSV holds the columns
// the table draws for the module under the view options, by the table's
// headers, and the cells as it shows them — spelled here view by view, as
// components/waste/business-workspace.tsx draws them, so a column added to
// one and not the other fails.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { CSV_BOM } from "../csv"
import { shownColumns, tableCsv, type ShownOptions, type ShownTable } from "../workspace-export"

const everything: ShownOptions = {
  showDescription: true,
  showContext: true,
  showUpdated: true,
  showArea: true,
  showContainerType: true,
  showWasteFraction: true,
  showAddress: true,
  showFillLevel: true,
  showNextCollection: true,
  showProject: true,
}
const nothing: ShownOptions = Object.fromEntries(Object.keys(everything).map((key) => [key, false])) as ShownOptions

const record = (extra: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id: "route-1",
  name: "RC-1042",
  context: "Copenhagen Central · Østerbro",
  status: "Planned",
  owner: "",
  value: "0/12 stops",
  updated: "2 min ago",
  description: "Monday's residual round",
  facts: { Vehicle: "WH-24", Driver: "Mads Jensen", Project: "Copenhagen Central", Area: "Østerbro" },
  related: [],
  source: "Waste API",
  freshness: "",
  ...extra,
})

const table = (extra: Partial<ShownTable> = {}): ShownTable => ({
  view: "records",
  rich: true,
  entityLabel: "Route",
  contextLabel: "Project · area",
  valueLabel: "Progress",
  options: everything,
  staticColumns: [],
  factColumns: ["Vehicle", "Driver"],
  ...extra,
})

const headers = (shown: ShownTable) => shownColumns(shown).map((column) => column.header)
const cells = (shown: ShownTable, row: BusinessRecord) => shownColumns(shown).map((column) => column.cell(row))

describe("shownColumns", () => {
  test("the generic rich view: the entity, its description, the pinned facts, the context, the status, the value, the fact columns and when it changed", () => {
    const shown = table({ staticColumns: ["Area"], factColumns: ["Vehicle", "Driver"] })
    assert.deepEqual(headers(shown), ["Route", "Description", "Area", "Project · area", "Status", "Progress", "Vehicle", "Driver", "Updated"])
    assert.deepEqual(cells(shown, record()), ["RC-1042", "Monday's residual round", "Østerbro", "Copenhagen Central · Østerbro", "Planned", "0/12 stops", "WH-24", "Mads Jensen", "2 min ago"])
  })

  test("leaves out what the view options switch off, and a list view has no fact columns", () => {
    assert.deepEqual(headers(table({ options: nothing })), ["Route", "Status", "Progress", "Vehicle", "Driver"])
    assert.deepEqual(headers(table({ options: nothing, rich: false })), ["Route", "Status", "Progress"])
  })

  test("a fact the record has not is the table's dash", () => {
    assert.deepEqual(cells(table({ options: nothing }), record({ facts: {} })), ["RC-1042", "Planned", "0/12 stops", "—", "—"])
  })

  test("the routes: Route ID, then the project and the area in place of the context", () => {
    assert.deepEqual(headers(table({ view: "routes", factColumns: [] })), ["Route ID", "Description", "Project", "Area", "Status", "Progress", "Updated"])
  })

  test("the provider's users: Full name, Email, Phone number and Role, no description and no value", () => {
    const user = record({ name: "Lars Mikkelsen", facts: { "User email": "lars@nordren.example", "Service provider role": "Manager" } })
    const shown = table({ view: "provider-users", rich: false })
    assert.deepEqual(headers(shown), ["Full name", "Email", "Phone number", "Role", "Status", "Updated"])
    assert.deepEqual(cells(shown, user), ["Lars Mikkelsen", "lars@nordren.example", "—", "Manager", "Planned", "2 min ago"])
  })

  test("the calendars: the project scope as the context, and the derived holidays and validity in place of the value", () => {
    const calendar = record({ name: "Copenhagen 2026", projectIds: ["project-copenhagen"] })
    const shown = table({
      view: "calendars",
      rich: false,
      contextLabel: "Scope",
      projectScopeOf: () => "Copenhagen Central",
      calendarRowOf: () => ({ holidays: "11 holidays", validity: "1 Jan 2026 – open" }),
    })
    assert.deepEqual(headers(shown), ["Route", "Description", "Scope", "Status", "Holidays", "Validity", "Progress", "Updated"])
    assert.deepEqual(cells(shown, calendar).slice(2, 7), ["Copenhagen Central", "Planned", "11 holidays", "1 Jan 2026 – open", "0/12 stops"])
    assert.equal(cells(shown, { ...calendar, projectIds: [] })[2], "—", "a calendar of no project reads the dash")
  })

  test("the schemes: the derived recurrence and fraction in place of the value", () => {
    const shown = table({ view: "schemes", rich: false, schemeRowOf: () => ({ recurrence: "Weekly · Mon", wasteFraction: "Residual" }) })
    assert.deepEqual(headers(shown), ["Route", "Description", "Project · area", "Status", "Recurrence", "Waste fraction", "Updated"])
    assert.deepEqual(cells(shown, record()).slice(4, 6), ["Weekly · Mon", "Residual"])
  })

  test("the containers' asset view: the container's own columns, the sensor read as the cell reads it", () => {
    const bin = record({ name: "C-1", description: "Front of the house", status: "In service", value: "62%", facts: { "Container ID": "BIN-1", "Container type": "240 L bin", "Waste fractions": "Residual", Address: "Parkvej 18", "Curb location": "By the gate", Sensor: "LoRa 4411", "Next collection": "Mon 5 Oct", Project: "Copenhagen Central" } })
    const shown = table({ view: "containers" })
    assert.deepEqual(headers(shown), ["Container ID", "Description", "Status", "Container type", "Waste fraction", "Address / location", "Fill level / sensor", "Next collection", "Project"])
    assert.deepEqual(cells(shown, bin), ["BIN-1", "Front of the house", "In service", "240 L bin", "Residual", "Parkvej 18 · By the gate", "62% · LoRa 4411", "Mon 5 Oct", "Copenhagen Central"])
    assert.equal(cells(shown, { ...bin, facts: { ...bin.facts, Sensor: "Not fitted" } })[6], "No sensor")
    assert.deepEqual(headers(table({ view: "containers", options: nothing })), ["Container ID", "Status"])
  })
})

describe("tableCsv", () => {
  test("is the rows under the columns' headers, in the order given", () => {
    const shown = shownColumns(table({ options: nothing, rich: false }))
    assert.equal(tableCsv([record(), record({ name: "RC-1043", status: "Ready", value: "0/9 stops" })], shown), `${CSV_BOM}Route,Status,Progress\r\nRC-1042,Planned,0/12 stops\r\nRC-1043,Ready,0/9 stops\r\n`)
  })
})
