import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { intervalCollectionsPerWeek, PROMISED_RATE_KEY, schemeFrequencyPromiseOfRecord } from "../../service-frequencies"
import { SCHEME_API_WARNINGS_KEY, schemeApiWarnings } from "../lifecycle"
import { schemeFrequencyReconciliationWarnings, servedDaysByContainer, servedFrequencyPromises } from "../validation"

describe("a promise's collections per week, read off the interval (O22 of #290)", () => {
  test("weeks-between divides, days-between states the weekly count, neither is the store's monthly, no rate is on demand", () => {
    assert.equal(intervalCollectionsPerWeek({ collectionsPerWeek: 1, weeksBetween: 1, daysBetween: null }), 1)
    assert.equal(intervalCollectionsPerWeek({ collectionsPerWeek: 1, weeksBetween: 2, daysBetween: null }), 1 / 2)
    assert.equal(intervalCollectionsPerWeek({ collectionsPerWeek: 2, weeksBetween: null, daysBetween: 3 }), 2)
    assert.equal(intervalCollectionsPerWeek({ collectionsPerWeek: 1, weeksBetween: null, daysBetween: null }), 12 / 52)
    assert.equal(intervalCollectionsPerWeek({ collectionsPerWeek: null, weeksBetween: null, daysBetween: null }), null)
  })

  test("a container read from the API names its promise by rate, and is never resolved against the fixture catalog", () => {
    const container = (rate: string, frequency?: string) => ({
      name: "BIN-1",
      facts: (frequency === undefined ? {} : { "Service frequency": frequency }) as Record<string, string>,
      submittedValues: { [PROMISED_RATE_KEY]: rate, serviceFrequencyId: "freq-weekly" },
    })
    assert.deepEqual(schemeFrequencyPromiseOfRecord(container("2", "Twice a week")), { containerName: "BIN-1", promisedName: "Twice a week", promisedRate: 2 })
    assert.equal(schemeFrequencyPromiseOfRecord(container("", "On demand")), null, "no standing promise, though the fixture id would resolve")
    assert.equal(schemeFrequencyPromiseOfRecord(container("1")), null, "a rate with no name to say it by")
  })
})

describe("a container is served at the cadence's rate on each day it is collected", () => {
  const plans = [
    { day: "thursday" as const, containerIds: ["a", "b"] },
    { day: "monday" as const, containerIds: ["a"] },
  ]

  test("its days are read off the per-day plans, in week order", () => {
    assert.deepEqual(Object.fromEntries(servedDaysByContainer(plans)), { a: ["monday", "thursday"], b: ["thursday"] })
  })

  test("a weekly scheme on Mon and Thu keeps a twice-a-week promise and over-serves a weekly one, naming the days", () => {
    const promises = servedFrequencyPromises(plans, [{ id: "a", rate: 2 }, { id: "b", rate: 2 }, { id: "c", rate: 1 }], (container) => ({
      containerName: container.id.toUpperCase(),
      promisedName: container.rate === 2 ? "Twice a week" : "Every week",
      promisedRate: container.rate,
    }))
    assert.deepEqual(
      promises.map((promise) => [promise.containerName, promise.servedDays]),
      [["A", ["monday", "thursday"]], ["B", ["thursday"]]],
      "a container no plan collects has no promise to reconcile",
    )
    assert.deepEqual(schemeFrequencyReconciliationWarnings({ frequency: "weekly", promises }), [
      "Recurrence Every week under-serves 1 container promised Twice a week (B) — raise the frequency or adjust the promised service frequency",
    ])
    const weekly = servedFrequencyPromises(plans, [{ id: "a" }], () => ({ containerName: "A", promisedName: "Every week", promisedRate: 1 }))
    assert.deepEqual(schemeFrequencyReconciliationWarnings({ frequency: "weekly", promises: weekly }), [
      "Recurrence Every week on Mon, Thu over-serves 1 container promised Every week (A) — collections run more often than the promised service frequency",
    ])
  })

  test("a promise without served days is judged at the cadence's one-day rate, as before", () => {
    assert.deepEqual(
      schemeFrequencyReconciliationWarnings({ frequency: "every-2-weeks", promises: [{ containerName: "A", promisedName: "Every week", promisedRate: 1 }] }),
      ["Recurrence Every 2 weeks under-serves 1 container promised Every week (A) — raise the frequency or adjust the promised service frequency"],
    )
  })
})

describe("a scheme the API answered carries the API's warnings", () => {
  test("read from the record, null where the API did not answer", () => {
    assert.deepEqual(schemeApiWarnings({ [SCHEME_API_WARNINGS_KEY]: JSON.stringify(["One"]) }), ["One"])
    assert.equal(schemeApiWarnings({}), null)
    assert.equal(schemeApiWarnings({ [SCHEME_API_WARNINGS_KEY]: "not json" }), null)
  })
})
