import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BASE_MAPS, defaultBaseMapForTheme, isBaseMapId } from "../base-maps"

describe("base maps", () => {
  test("four keyless options, streets first, each with a style and a swatch", () => {
    assert.deepEqual(BASE_MAPS.map((map) => map.id), ["streets", "light", "dark", "satellite"])
    for (const map of BASE_MAPS) {
      assert.ok(map.label)
      assert.ok(typeof map.style === "string" ? map.style.startsWith("https://") : map.style.version === 8)
      assert.ok(map.swatch.land && map.swatch.water && map.swatch.road)
    }
  })

  test("the theme picks the default and ids are validated", () => {
    assert.equal(defaultBaseMapForTheme("light"), "streets")
    assert.equal(defaultBaseMapForTheme("dark"), "dark")
    assert.equal(isBaseMapId("satellite"), true)
    assert.equal(isBaseMapId("terrain"), false)
    assert.equal(isBaseMapId(null), false)
  })
})
