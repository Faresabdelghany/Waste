// The lifecycle's readings on the Pilot (#291, slice 10c): what a pause
// offers on the project's day — cancel before it begins, resume while it
// runs, nothing once it has ended — the line it reads as, its last day in
// as every end is spelled, and the sentence the stops a command left
// standing are told in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { StopToRemove } from "@waste/contracts/agreements"

import { CHANGE_SERVICE_FORM, PAUSE_FORM, pauseLine, pauseOffers, stopsToRemoveSentence, TERMINATE_FORM } from "../subscription-lifecycle"

const fieldIds = (schema: typeof PAUSE_FORM) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))

describe("a pause on the project's day", () => {
  const pause = { validFrom: "2026-11-02", validTo: "2026-11-16" }

  test("offers its cancel before it begins, its resume while it runs, and nothing once it has ended", () => {
    assert.equal(pauseOffers(pause, "2026-11-01"), "cancel")
    assert.equal(pauseOffers(pause, "2026-11-02"), "resume", "its first day: it has begun")
    assert.equal(pauseOffers(pause, "2026-11-15"), "resume")
    assert.equal(pauseOffers(pause, "2026-11-16"), null, "collections resume that day")
    assert.equal(pauseOffers({ ...pause, validTo: null }, "2027-06-01"), "resume", "open: until it is resumed")
  })

  test("reads as its first and last day in, and what it is on the day", () => {
    assert.equal(pauseLine(pause, "2026-11-01"), "Paused 2026-11-02 – 2026-11-15 · planned")
    assert.equal(pauseLine(pause, "2026-11-05"), "Paused 2026-11-02 – 2026-11-15 · running")
    assert.equal(pauseLine(pause, "2026-11-20"), "Paused 2026-11-02 – 2026-11-15 · ended")
    assert.equal(pauseLine({ ...pause, validTo: null }, "2026-11-05"), "Paused from 2026-11-02 until resumed · running")
  })
})

describe("the stops a command left standing", () => {
  const stop = (n: number, day: string): StopToRemove => ({ routeId: `r${n}`, routeLabel: `RC-104${n}`, operatingDate: day, pickupId: `p${n}`, containerId: "c" })

  test("are told by route and day, the first three named and the rest counted; none is no sentence", () => {
    assert.equal(stopsToRemoveSentence([]), null)
    assert.equal(stopsToRemoveSentence([stop(1, "2026-11-03")]), "1 stop to remove by hand: RC-1041 on 2026-11-03")
    assert.equal(
      stopsToRemoveSentence([stop(1, "2026-11-03"), stop(2, "2026-11-04"), stop(3, "2026-11-05"), stop(4, "2026-11-06"), stop(5, "2026-11-07")]),
      "5 stops to remove by hand: RC-1041 on 2026-11-03, RC-1042 on 2026-11-04, RC-1043 on 2026-11-05 and 2 more",
    )
  })
})

describe("the dialogs", () => {
  test("ask what the actions' bodies read, by the same field ids", () => {
    assert.deepEqual(fieldIds(CHANGE_SERVICE_FORM([])), ["from", "productId", "quantity"])
    assert.deepEqual(fieldIds(PAUSE_FORM), ["from", "lastDay"])
    assert.deepEqual(fieldIds(TERMINATE_FORM), ["lastDay"])
    for (const schema of [CHANGE_SERVICE_FORM([]), PAUSE_FORM, TERMINATE_FORM]) assert.equal(schema.execution?.kind, "append-event", `${schema.title}: the form dialog renders nothing without an execution`)
    const products = [{ value: "product-1", label: "Residual 240 L" }]
    assert.deepEqual(CHANGE_SERVICE_FORM(products).sections[0].fields.find((field) => field.id === "productId")?.options, products, "the product picker offers what it is handed")
  })
})
