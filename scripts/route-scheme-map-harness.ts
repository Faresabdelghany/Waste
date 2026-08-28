// Headless checks for the Route Scheme map geometry (spec FR-15, ticket #6):
// stable per-day colors, deterministic illustrative stop positions, and the
// polyline points a day's route line renders from.
// Run: npx tsx scripts/route-scheme-map-harness.ts
import { SERVICE_DAYS } from "../lib/route-schemes/recurrence"
import {
  MAP_VIEWBOX,
  SCHEME_DAY_COLORS,
  dayPolylinePoints,
  stopPosition,
} from "../lib/route-schemes/map"

let passed = 0
let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed += 1
  else failed += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  )
}

/* ----------------------------- day colors -------------------------------- */

check(
  "every service day has a color",
  SERVICE_DAYS.every((day) => /^#[0-9a-f]{6}$/i.test(SCHEME_DAY_COLORS[day])),
  true,
)

check(
  "day colors are pairwise distinct",
  new Set(Object.values(SCHEME_DAY_COLORS)).size,
  SERVICE_DAYS.length,
)

/* ---------------------------- stop positions ------------------------------ */

const posA = stopPosition("container-rc-0142")
const posB = stopPosition("container-rc-0142")

check("same container id always lands on the same spot", posA, posB)

check(
  "different ids land on different spots",
  stopPosition("container-rc-0001").x === stopPosition("container-rc-0002").x &&
    stopPosition("container-rc-0001").y === stopPosition("container-rc-0002").y,
  false,
)

const ids = Array.from({ length: 200 }, (_, index) => `container-rc-${index}`)
check(
  "positions keep a margin off every map edge",
  ids.every((id) => {
    const { x, y } = stopPosition(id)
    return (
      x >= 10 &&
      x <= MAP_VIEWBOX.width - 10 &&
      y >= 12 &&
      y <= MAP_VIEWBOX.height - 14
    )
  }),
  true,
)

/* --------------------------- polyline points ------------------------------ */

check(
  "polyline points follow the picked order",
  dayPolylinePoints(["container-rc-0001", "container-rc-0002"]),
  [
    `${stopPosition("container-rc-0001").x},${stopPosition("container-rc-0001").y}`,
    `${stopPosition("container-rc-0002").x},${stopPosition("container-rc-0002").y}`,
  ].join(" "),
)

check("a day with no containers renders no line", dayPolylinePoints([]), "")

check(
  "a single stop renders no line either — a line needs two points",
  dayPolylinePoints(["container-rc-0001"]),
  "",
)

/* -------------------------------- summary --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
