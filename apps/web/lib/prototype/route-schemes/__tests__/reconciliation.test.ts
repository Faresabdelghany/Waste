import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PROMISED_RATE_KEY, schemeFrequencyPromiseOfRecord } from "../../service-frequencies"
import { SCHEME_API_WARNINGS_KEY, schemeApiWarnings } from "../lifecycle"

describe("a container's promise, read off its record (O22 of #290)", () => {
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

describe("a scheme the API answered carries the API's warnings", () => {
  test("read from the record, null where the API did not answer", () => {
    assert.deepEqual(schemeApiWarnings({ [SCHEME_API_WARNINGS_KEY]: JSON.stringify(["One"]) }), ["One"])
    assert.equal(schemeApiWarnings({}), null)
    assert.equal(schemeApiWarnings({ [SCHEME_API_WARNINGS_KEY]: "not json" }), null)
  })
})
