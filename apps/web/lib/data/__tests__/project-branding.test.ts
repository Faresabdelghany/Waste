// A project's branding in Settings › Portals & branding on the Pilot (M22 of
// #293): read off the project record's JSON, a colour judged against white
// text at WCAG 2.1 AA before the API is asked, addresses https, and written
// whole from a form whose empty parts are none.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { addressRefusalOf, BRANDING_KEY, brandColorRefusalOf, brandingFormOf, brandingFromForm, brandingOf, contrastLabelOf, NO_BRANDING } from "../project-branding"

const projectWith = (value: unknown): BusinessRecord => ({ id: "project-copenhagen", name: "Copenhagen Central", submittedValues: value === undefined ? {} : { [BRANDING_KEY]: value } }) as unknown as BusinessRecord

describe("a project's branding", () => {
  test("is read off the record's JSON, and is none where the record carries none", () => {
    const branding = { brandColor: "#1f6f3f", logoUrl: "https://kk.dk/logo.svg", accessibilityStatementUrl: null }
    assert.deepEqual(brandingOf(projectWith(JSON.stringify(branding))), branding)
    assert.deepEqual(brandingOf(projectWith(undefined)), NO_BRANDING)
    assert.deepEqual(brandingOf(projectWith("{")), NO_BRANDING)
  })

  test("judges the colour against white text at AA, and the addresses as https, before the API", () => {
    assert.equal(brandColorRefusalOf(""), null)
    assert.equal(brandColorRefusalOf("#1F6F3F"), null)
    assert.equal(brandColorRefusalOf("green"), "A colour is a hash and six hex digits, as #1f6f3f")
    assert.match(brandColorRefusalOf("#FFD700") ?? "", /^White text on #ffd700 has a contrast of 1\.\d\d to 1/)
    assert.equal(contrastLabelOf("#1f6f3f"), "Contrast with white text 6.17 to 1 — meets WCAG 2.1 AA")
    assert.match(contrastLabelOf("#ffd700") ?? "", /fails WCAG 2\.1 AA$/)
    assert.equal(contrastLabelOf("#1f6"), null)
    assert.equal(addressRefusalOf("http://kk.dk/logo.svg"), "An address is https, as https://kk.dk/logo.svg")
    assert.equal(addressRefusalOf(" https://kk.dk/logo.svg "), null)
  })

  test("is written whole from the form: the colour lowercased, an empty part none, nothing while a part will not do", () => {
    assert.deepEqual(brandingFromForm({ brandColor: "#1F6F3F", logoUrl: " https://kk.dk/logo.svg ", accessibilityStatementUrl: "" }), { brandColor: "#1f6f3f", logoUrl: "https://kk.dk/logo.svg", accessibilityStatementUrl: null })
    assert.deepEqual(brandingFromForm(brandingFormOf(NO_BRANDING)), NO_BRANDING)
    assert.equal(brandingFromForm({ brandColor: "#ffd700", logoUrl: "", accessibilityStatementUrl: "" }), null)
  })
})
