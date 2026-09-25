import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Alert, AlertAcknowledge, AlertCreate, AlertLinkTicket, AlertListQuery, AlertResolve, NAMES_A_SUBJECT, namesASubject } from "../alerts"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-05T14:00:00.000Z", updatedAt: "2026-10-05T14:00:00.000Z" }
const WHEN = "2026-10-05T13:55:00.000Z"

const alert = {
  id: ID,
  projectId: OTHER,
  kind: "route-exception",
  severity: "high",
  source: "manual",
  status: "new",
  title: "Route RC-1042 ended with a stop uncollected",
  details: "One failed pickup at Parkvej 18",
  detectedAt: WHEN,
  routeId: THIRD,
  vehicleId: null,
  driverId: null,
  containerId: null,
  ticketId: null,
  raisedBy: OTHER,
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...STAMPS,
}

describe("Alert", () => {
  test("carries its kind, severity, source and status, its words, when it was seen, what it is about, the ticket it links to and the two pairs of stamps", () => {
    assert.deepEqual(Alert.parse(alert), alert)
    const acknowledged = { ...alert, status: "acknowledged", acknowledgedAt: "2026-10-05T14:10:00.000Z", acknowledgedBy: OTHER }
    assert.deepEqual(Alert.parse(acknowledged), acknowledged)
    const resolved = { ...acknowledged, status: "resolved", resolvedAt: "2026-10-05T16:00:00.000Z", resolvedBy: THIRD, resolutionNote: "Re-collected", ticketId: ID }
    assert.deepEqual(Alert.parse(resolved), resolved)
    // A resolved alert may never have been acknowledged; the table's stamps check says so, and the schema does not second-guess the row.
    const straight = { ...alert, status: "resolved", resolvedAt: "2026-10-05T16:00:00.000Z", resolvedBy: THIRD }
    assert.deepEqual(Alert.parse(straight), straight)
  })

  test("holds every enum to its vocabulary and the text to its shape", () => {
    for (const [field, value] of [
      ["kind", "Route event"],
      ["severity", "urgent"],
      ["source", "IoT sensor"],
      ["status", "linked"],
    ] as const) {
      assert.deepEqual(refusal(Alert.safeParse({ ...alert, [field]: value })).map((issue) => issue.path), [field], field)
    }
    assert.deepEqual(refusal(Alert.safeParse({ ...alert, title: "   " })).map((issue) => issue.path), ["title"])
    assert.deepEqual(refusal(Alert.safeParse({ ...alert, resolutionNote: "   " })).map((issue) => issue.path), ["resolutionNote"])
    assert.deepEqual(refusal(Alert.safeParse({ ...alert, detectedAt: "2026-10-05" })).map((issue) => issue.path), ["detectedAt"])
    assert.deepEqual(refusal(Alert.safeParse({ ...alert, vehicleId: "WH-24" })).map((issue) => issue.path), ["vehicleId"])
  })
})

describe("AlertCreate", () => {
  const body = { projectId: OTHER, title: "WH-24 due for service", details: "The workshop wants it Friday", kind: "resource", severity: "medium", vehicleId: THIRD }

  test("takes the words, the kind, the severity, when it was seen and what it is about; the source, the status and who raised it are the server's", () => {
    assert.deepEqual(AlertCreate.parse(body), body)
    const whole = { ...body, detectedAt: WHEN, routeId: ID, driverId: null, containerId: null, ticketId: OTHER }
    assert.deepEqual(AlertCreate.parse(whole), whole)
    refusesWhatTheServerOwns(AlertCreate, body)
    for (const [key, value] of [
      ["source", "manual"],
      ["status", "new"],
      ["raisedBy", OTHER],
      ["acknowledgedAt", WHEN],
      ["acknowledgedBy", OTHER],
      ["resolvedAt", WHEN],
      ["resolvedBy", OTHER],
      ["resolutionNote", "x"],
    ] as const) {
      const issues = refusal(AlertCreate.safeParse({ ...body, [key]: value }))
      assert.deepEqual(
        issues.map((issue) => issue.path),
        [""],
        key,
      )
      assert.match(issues[0].message, new RegExp(key))
    }
  })

  test("names what it is about: a route, a vehicle, a driver or a container, at least one", () => {
    const aboutNothing = { projectId: OTHER, title: "Something is off", details: "Not sure what", kind: "other", severity: "low" }
    assert.deepEqual(refusal(AlertCreate.safeParse(aboutNothing)), [{ path: "routeId", message: NAMES_A_SUBJECT }])
    assert.deepEqual(refusal(AlertCreate.safeParse({ ...aboutNothing, routeId: null, vehicleId: null, driverId: null, containerId: null })), [{ path: "routeId", message: NAMES_A_SUBJECT }])
    for (const field of ["routeId", "vehicleId", "driverId", "containerId"]) assert.equal(AlertCreate.safeParse({ ...aboutNothing, [field]: THIRD }).success, true, field)
    assert.equal(AlertCreate.safeParse({ ...aboutNothing, routeId: THIRD, containerId: ID }).success, true, "several")
    assert.equal(namesASubject({}), false)
    assert.equal(namesASubject({ driverId: null, containerId: THIRD }), true)
  })

  test("holds the kind, the severity, the instant and the text to their shapes", () => {
    assert.deepEqual(refusal(AlertCreate.safeParse({ ...body, kind: "telemetry" })).map((issue) => issue.path), ["kind"])
    assert.deepEqual(refusal(AlertCreate.safeParse({ ...body, severity: "none" })).map((issue) => issue.path), ["severity"])
    assert.deepEqual(refusal(AlertCreate.safeParse({ ...body, detectedAt: "yesterday" })).map((issue) => issue.path), ["detectedAt"])
    assert.deepEqual(refusal(AlertCreate.safeParse({ ...body, details: " " })).map((issue) => issue.path), ["details"])
    assert.deepEqual(refusal(AlertCreate.safeParse({ ...body, ticketId: null })).map((issue) => issue.path), ["ticketId"], "an alert raised about no ticket leaves the field out")
  })
})

describe("the three commands", () => {
  test("acknowledge says nothing, and a body with a member is refused", () => {
    assert.deepEqual(AlertAcknowledge.parse({}), {})
    assert.deepEqual(refusal(AlertAcknowledge.safeParse({ note: "Seen" })).map((issue) => issue.path), [""])
    assert.deepEqual(refusal(AlertAcknowledge.safeParse({ acknowledgedBy: OTHER })).map((issue) => issue.path), [""])
  })

  test("resolve may carry the note; link-ticket names the one ticket", () => {
    assert.deepEqual(AlertResolve.parse({}), {})
    assert.deepEqual(AlertResolve.parse({ note: "Serviced Friday" }), { note: "Serviced Friday" })
    assert.deepEqual(refusal(AlertResolve.safeParse({ note: "  " })).map((issue) => issue.path), ["note"])
    assert.deepEqual(refusal(AlertResolve.safeParse({ resolvedAt: WHEN })).map((issue) => issue.path), [""])
    assert.deepEqual(AlertLinkTicket.parse({ ticketId: ID }), { ticketId: ID })
    assert.deepEqual(refusal(AlertLinkTicket.safeParse({})).map((issue) => issue.path), ["ticketId"])
    assert.deepEqual(refusal(AlertLinkTicket.safeParse({ ticketId: null })).map((issue) => issue.path), ["ticketId"], "an alert is unlinked by nothing")
    assert.deepEqual(refusal(AlertLinkTicket.safeParse({ ticketId: "T-8831" })).map((issue) => issue.path), ["ticketId"])
  })
})

describe("AlertListQuery", () => {
  test("pages by project, status, severity, kind, the four links and the ticket", () => {
    assert.deepEqual(AlertListQuery.parse({}), { limit: 50 })
    assert.deepEqual(AlertListQuery.parse({ status: "new", severity: "critical", kind: "asset", containerId: ID, ticketId: OTHER, limit: "10" }), { limit: 10, status: "new", severity: "critical", kind: "asset", containerId: ID, ticketId: OTHER })
    for (const field of ["projectId", "routeId", "vehicleId", "driverId", "containerId", "ticketId"]) {
      assert.equal(AlertListQuery.safeParse({ [field]: THIRD }).success, true, field)
      assert.deepEqual(refusal(AlertListQuery.safeParse({ [field]: "x" })).map((issue) => issue.path), [field], field)
    }
    assert.deepEqual(refusal(AlertListQuery.safeParse({ status: "linked" })).map((issue) => issue.path), ["status"])
  })
})
