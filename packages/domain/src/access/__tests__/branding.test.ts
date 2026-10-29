// A project's branding (M22 of #293): a colour as #RRGGBB that white text
// reads on at WCAG 2.1 AA, and https addresses for the logo and the
// statement.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AA_CONTRAST, brandColorReadable, brandColorRefusal, contrastRatio, isBrandColor, isHttpsAddress, relativeLuminance } from "../branding"

describe("a project's brand colour", () => {
  test("is six hex digits after a hash", () => {
    for (const color of ["#1f6f3f", "#ABCDEF", "#000000"]) assert.equal(isBrandColor(color), true, color)
    for (const color of ["1f6f3f", "#1f6f3", "#1f6f3fa", "#ggg000", "red", ""]) assert.equal(isBrandColor(color), false, color)
  })

  test("contrast is WCAG 2.1's: black on white 21 to 1, a colour on itself 1 to 1, the same either way round", () => {
    assert.equal(relativeLuminance("#ffffff"), 1)
    assert.equal(relativeLuminance("#000000"), 0)
    assert.equal(contrastRatio("#000000", "#ffffff"), 21)
    assert.equal(contrastRatio("#1f6f3f", "#1f6f3f"), 1)
    assert.equal(contrastRatio("#767676", "#ffffff"), contrastRatio("#ffffff", "#767676"))
  })

  test("is readable behind white text at AA's 4.5 to 1, the threshold's own grey just passing and a lighter one not", () => {
    assert.ok(contrastRatio("#767676", "#ffffff") >= AA_CONTRAST)
    assert.equal(brandColorReadable("#767676"), true)
    assert.equal(brandColorReadable("#777777"), false)
    assert.equal(brandColorReadable("#1f6f3f"), true)
    assert.equal(brandColorReadable("#ffd700"), false)
    assert.match(brandColorRefusal("#ffd700"), /^White text on #ffd700 has a contrast of 1\.\d\d to 1; WCAG 2\.1 AA needs 4\.5 to 1/)
  })
})

describe("a project's logo and statement addresses", () => {
  test("are https with a host and no whitespace, within the length", () => {
    for (const address of ["https://kk.dk/logo.svg", "https://was.digst.dk/kk-dk", "https://example.dk"]) assert.equal(isHttpsAddress(address), true, address)
    for (const address of ["http://kk.dk/logo.svg", "https://", "https:///logo.svg", "https://kk.dk/a logo.svg", "javascript:alert(1)", `https://kk.dk/${"a".repeat(2048)}`]) assert.equal(isHttpsAddress(address), false, address)
  })
})
